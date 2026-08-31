const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/socket.io', express.static(__dirname + '/node_modules/socket.io/client-dist'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
let ai = null;

const rooms = new Map();

function getGeminiClient() {
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  return ai;
}

function buildLeaderboard(room) {
  return Object.values(room.scores || {})
    .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
}

function parseQuizResponse(rawText, expectedCount = 1) {
  const cleanedText = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const jsonMatch = cleanedText.match(/\[[\s\S]*\]/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleanedText);

  if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
    throw new Error('Gemini returned an invalid quiz array.');
  }

  return parsed.map((quizItem, index) => {
    if (
      !quizItem ||
      typeof quizItem.question !== 'string' ||
      !Array.isArray(quizItem.options) ||
      quizItem.options.length !== 4 ||
      !Number.isInteger(quizItem.correctAnswerIndex) ||
      quizItem.correctAnswerIndex < 0 ||
      quizItem.correctAnswerIndex > 3
    ) {
      throw new Error('Gemini returned an invalid quiz schema.');
    }

    return {
      id: `q-${Date.now()}-${index}`,
      question: quizItem.question,
      options: quizItem.options.map(option => String(option)),
      correctAnswerIndex: quizItem.correctAnswerIndex
    };
  });
}

app.get('/', (req, res) => {
  res.send('Study Room in-memory backend is running!');
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join_room', ({ roomId, username }) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { name: roomId, users: [], notes: '', tasks: [], scores: {}, currentQuiz: [] });
    }

    const room = rooms.get(roomId);
    room.users.push({ id: socket.id, username });
    room.scores[socket.id] = { socketId: socket.id, username, score: 0, answeredQuestions: {} };

    io.to(roomId).emit('room_data_update', room);
    io.to(roomId).emit('leaderboard_update', buildLeaderboard(room));

    socket.on('update_notes', (newContent) => {
      room.notes = newContent;
      socket.to(roomId).emit('receive_note_update', newContent);
    });

    socket.on('send_message', (messageData) => {
      io.to(roomId).emit('receive_message', messageData);
    });

    socket.on('ask_ai', async ({ prompt, notesContext }) => {
      const studentPrompt = typeof prompt === 'string' ? prompt.trim() : '';
      const sharedNotes = typeof notesContext === 'string' ? notesContext.trim() : '';

      if (!studentPrompt) {
        socket.emit('ai_response', { text: 'Ask me a study question and I will help from the shared notes.' });
        return;
      }

      if (!process.env.GEMINI_API_KEY) {
        socket.emit('ai_response', { text: 'AI Study Assistant is not configured yet. Please set GEMINI_API_KEY on the server.' });
        return;
      }

      try {
        const response = await getGeminiClient().models.generateContent({
          model: 'gemini-3.6-flash',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: [
                    'System persona: You are a focused AI Study Assistant inside a collaborative study room. Help students understand concepts, summarize notes, create quiz questions, and suggest next steps. Be concise, accurate, encouraging, and base your answer on the shared notes when they are relevant.',
                    `Current shared notes context:\n${sharedNotes || 'No shared notes have been added yet.'}`,
                    `Student question:\n${studentPrompt}`
                  ].join('\n\n')
                }
              ]
            }
          ]
        });

        socket.emit('ai_response', { text: response.text || 'I could not generate a response this time. Please try again.' });
      } catch (error) {
        console.error('Gemini ask_ai error:', error);
        socket.emit('ai_response', { text: 'Sorry, the AI Study Assistant hit an error. Please try again in a moment.' });
      }
    });

    socket.on('generate_quiz', async ({ notesContext, numQuestions }) => {
      const sharedNotes = typeof notesContext === 'string' ? notesContext.trim() : '';
      const questionCount = Number.parseInt(numQuestions, 10);
      const safeQuestionCount = [3, 5, 10].includes(questionCount) ? questionCount : 3;

      if (!process.env.GEMINI_API_KEY) {
        socket.emit('ai_response', { text: 'Quiz generation is not configured yet. Please set GEMINI_API_KEY on the server.' });
        return;
      }

      try {
        const response = await getGeminiClient().models.generateContent({
          model: 'gemini-3.6-flash',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: [
                    'You are a study quiz generator for a collaborative classroom.',
                    `Create exactly ${safeQuestionCount} multiple-choice quiz questions based on the shared notes context.`,
                    'Return only valid JSON. Do not include markdown, prose, explanations, or code fences.',
                    'The JSON must follow this exact shape:',
                    '[{"question":"...","options":["...","...","...","..."],"correctAnswerIndex":0}]',
                    `Shared notes context:\n${sharedNotes || 'No shared notes have been added yet. Create a general study skills question.'}`
                  ].join('\n\n')
                }
              ]
            }
          ]
        });

        const quizData = parseQuizResponse(response.text, safeQuestionCount);
        room.currentQuiz = quizData;
        Object.values(room.scores).forEach(score => {
          score.score = 0;
          score.answeredQuestions = {};
        });
        io.to(roomId).emit('new_quiz_question', quizData.map(({ correctAnswerIndex, ...question }) => question));
        io.to(roomId).emit('leaderboard_update', buildLeaderboard(room));
      } catch (error) {
        console.error('Gemini generate_quiz error:', error);
        socket.emit('ai_response', { text: 'Sorry, I could not generate a valid quiz question. Please try again.' });
      }
    });

    socket.on('submit_answer', ({ questionId, selectedAnswerIndex }) => {
      const selectedIndex = Number.parseInt(selectedAnswerIndex, 10);
      const question = room.currentQuiz.find(quizItem => quizItem.id === questionId);
      const scoreRecord = room.scores[socket.id];

      if (!question || !scoreRecord || !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 3) {
        socket.emit('answer_result', {
          questionId,
          correct: false,
          correctAnswerIndex: question ? question.correctAnswerIndex : null,
          message: 'This answer could not be submitted.'
        });
        return;
      }

      if (scoreRecord.answeredQuestions[questionId]) {
        socket.emit('answer_result', {
          questionId,
          selectedAnswerIndex: scoreRecord.answeredQuestions[questionId].selectedAnswerIndex,
          correct: scoreRecord.answeredQuestions[questionId].correct,
          correctAnswerIndex: question.correctAnswerIndex,
          message: 'You already answered this question.'
        });
        return;
      }

      const correct = selectedIndex === question.correctAnswerIndex;
      scoreRecord.answeredQuestions[questionId] = { selectedAnswerIndex: selectedIndex, correct };

      if (correct) {
        scoreRecord.score += 1;
      }

      socket.emit('answer_result', {
        questionId,
        selectedAnswerIndex: selectedIndex,
        correct,
        correctAnswerIndex: question.correctAnswerIndex,
        message: correct ? 'Correct. Nice work.' : 'Not quite. The highlighted option is correct.'
      });
      io.to(roomId).emit('leaderboard_update', buildLeaderboard(room));
    });

    socket.on('disconnect', () => {
      room.users = room.users.filter(user => user.id !== socket.id);
      delete room.scores[socket.id];
      io.to(roomId).emit('room_data_update', room);
      io.to(roomId).emit('leaderboard_update', buildLeaderboard(room));
      console.log(`User disconnected: ${socket.id}`);
    });
  });
});

server.listen(5000, () => {
  console.log('In-memory study room server running on port 5000');
});
