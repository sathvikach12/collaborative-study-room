const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('Only PDF files are supported.'));
      return;
    }

    cb(null, true);
  }
});

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

function buildRoomUpdate(room) {
  return {
    name: room.name,
    users: room.users,
    notes: room.notes,
    pdfFileName: room.pdfFileName,
    hasPdfContext: Boolean(room.pdfContext),
    cursors: Object.values(room.cursors || {}),
    pomodoro: room.pomodoro,
    bookmarks: room.bookmarks
  };
}

function createRoomState(roomId) {
  return {
    name: roomId,
    users: [],
    notes: '',
    pdfContext: '',
    pdfFileName: '',
    tasks: [],
    scores: {},
    currentQuiz: [],
    flashcards: [],
    flashcardState: { index: 0, flipped: false },
    cursors: {},
    pomodoro: {
      mode: 'work',
      duration: 25 * 60,
      remaining: 25 * 60,
      running: false,
      startedAt: null
    },
    bookmarks: []
  };
}

function getPomodoroSnapshot(pomodoro) {
  if (!pomodoro.running || !pomodoro.startedAt) {
    return pomodoro;
  }

  const elapsed = Math.floor((Date.now() - pomodoro.startedAt) / 1000);
  const remaining = Math.max(0, pomodoro.remaining - elapsed);
  return {
    ...pomodoro,
    remaining,
    running: remaining > 0,
    startedAt: remaining > 0 ? pomodoro.startedAt : null
  };
}

function removeUserFromRoom(socket, roomId) {
  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  const leavingUser = room.users.find(user => user.id === socket.id);
  room.users = room.users.filter(user => user.id !== socket.id);
  delete room.scores[socket.id];
  delete room.cursors[socket.id];

  socket.leave(roomId);
  io.to(roomId).emit('room_data_update', buildRoomUpdate(room));
  io.to(roomId).emit('leaderboard_update', buildLeaderboard(room));
  io.to(roomId).emit('cursor_presence_update', Object.values(room.cursors || {}));
  if (leavingUser) {
    io.to(roomId).emit('user_left', { username: leavingUser.username });
  }

  if (!room.users.length) {
    rooms.delete(roomId);
  }
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

function parseFlashcardResponse(rawText) {
  const cleanedText = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const jsonMatch = cleanedText.match(/\[[\s\S]*\]/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleanedText);

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('Gemini returned an invalid flashcard array.');
  }

  return parsed.slice(0, 20).map((flashcard, index) => {
    if (
      !flashcard ||
      typeof flashcard.front !== 'string' ||
      typeof flashcard.back !== 'string' ||
      !flashcard.front.trim() ||
      !flashcard.back.trim()
    ) {
      throw new Error('Gemini returned an invalid flashcard schema.');
    }

    return {
      id: `fc-${Date.now()}-${index}`,
      front: flashcard.front.trim(),
      back: flashcard.back.trim()
    };
  });
}

app.get('/', (req, res) => {
  res.send('Study Room in-memory backend is running!');
});

app.post('/api/upload-pdf', upload.single('pdf'), async (req, res) => {
  const roomId = typeof req.body.roomId === 'string' ? req.body.roomId.trim() : '';

  if (!roomId) {
    res.status(400).json({ error: 'A roomId is required.' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'Please upload a PDF file.' });
    return;
  }

  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoomState(roomId));
  }

  let parser = null;

  try {
    parser = new PDFParse({ data: req.file.buffer });
    const parsedPdf = await parser.getText();
    const text = String(parsedPdf.text || '').trim();
    const room = rooms.get(roomId);
    room.pdfContext = text;
    room.pdfFileName = req.file.originalname;
    const pageCount = Array.isArray(parsedPdf.pages) ? parsedPdf.pages.length : 0;

    io.to(roomId).emit('pdf_context_update', {
      fileName: room.pdfFileName,
      pageCount,
      characterCount: text.length
    });

    res.json({
      fileName: room.pdfFileName,
      pageCount,
      characterCount: text.length
    });
  } catch (error) {
    console.error('PDF upload error:', error);
    res.status(422).json({ error: 'Could not extract text from this PDF.' });
  } finally {
    if (parser) {
      await parser.destroy();
    }
  }
});

app.use('/api/upload-pdf', (error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'PDF uploads are limited to 5MB.' });
    return;
  }

  if (error) {
    res.status(400).json({ error: error.message || 'PDF upload failed.' });
    return;
  }

  next();
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join_room', ({ roomId, username }) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, createRoomState(roomId));
    }

    const room = rooms.get(roomId);
    const existingUser = room.users.find(user => user.id === socket.id);
    if (existingUser) {
      existingUser.username = username;
    } else {
      room.users.push({ id: socket.id, username });
    }
    room.scores[socket.id] = { socketId: socket.id, username, score: 0, answeredQuestions: {} };

    io.to(roomId).emit('room_data_update', buildRoomUpdate(room));
    io.to(roomId).emit('leaderboard_update', buildLeaderboard(room));
    socket.to(roomId).emit('user_joined', { username });
    socket.emit('pomodoro_update', getPomodoroSnapshot(room.pomodoro));
    socket.emit('bookmark_update', room.bookmarks);
    socket.emit('cursor_presence_update', Object.values(room.cursors || {}));

    socket.on('update_notes', (newContent) => {
      room.notes = newContent;
      socket.to(roomId).emit('receive_note_update', newContent);
    });

    socket.on('cursor_update', ({ position, line, column }) => {
      const safePosition = Number.parseInt(position, 10);
      const safeLine = Number.parseInt(line, 10);
      const safeColumn = Number.parseInt(column, 10);

      if (!Number.isInteger(safePosition) || safePosition < 0) {
        return;
      }

      room.cursors[socket.id] = {
        socketId: socket.id,
        username,
        position: safePosition,
        line: Number.isInteger(safeLine) ? safeLine : 1,
        column: Number.isInteger(safeColumn) ? safeColumn : 1,
        updatedAt: Date.now()
      };
      io.to(roomId).emit('cursor_presence_update', Object.values(room.cursors || {}));
    });

    socket.on('pomodoro_action', ({ action, mode } = {}) => {
      const current = getPomodoroSnapshot(room.pomodoro);
      const nextMode = mode === 'break' ? 'break' : 'work';
      const nextDuration = nextMode === 'break' ? 5 * 60 : 25 * 60;

      if (action === 'start') {
        room.pomodoro = {
          ...current,
          running: true,
          startedAt: Date.now()
        };
      } else if (action === 'pause') {
        room.pomodoro = {
          ...current,
          running: false,
          startedAt: null
        };
      } else if (action === 'reset') {
        room.pomodoro = {
          mode: nextMode,
          duration: nextDuration,
          remaining: nextDuration,
          running: false,
          startedAt: null
        };
      } else {
        return;
      }

      io.to(roomId).emit('pomodoro_update', getPomodoroSnapshot(room.pomodoro));
    });

    socket.on('add_bookmark', ({ title, url }) => {
      const safeTitle = typeof title === 'string' ? title.trim().slice(0, 90) : '';
      const safeUrl = typeof url === 'string' ? url.trim() : '';
      let parsedUrl = null;

      try {
        parsedUrl = new URL(safeUrl);
      } catch (error) {
        socket.emit('bookmark_error', { message: 'Enter a valid resource link.' });
        return;
      }

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        socket.emit('bookmark_error', { message: 'Resource links must start with http:// or https://.' });
        return;
      }

      room.bookmarks.unshift({
        id: `bm-${Date.now()}-${socket.id}`,
        title: safeTitle || parsedUrl.hostname,
        url: parsedUrl.toString(),
        username,
        createdAt: Date.now()
      });
      room.bookmarks = room.bookmarks.slice(0, 30);
      io.to(roomId).emit('bookmark_update', room.bookmarks);
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

    socket.on('generate_flashcards', async () => {
      const latestRoom = rooms.get(roomId);
      const combinedContext = [
        latestRoom?.notes ? `Shared notes:\n${latestRoom.notes}` : '',
        latestRoom?.pdfContext ? `Uploaded PDF content:\n${latestRoom.pdfContext}` : ''
      ].filter(Boolean).join('\n\n').trim();

      if (!process.env.GEMINI_API_KEY) {
        socket.emit('ai_response', { text: 'Flashcard generation is not configured yet. Please set GEMINI_API_KEY on the server.' });
        return;
      }

      if (!combinedContext) {
        socket.emit('ai_response', { text: 'Add shared notes or upload a PDF before generating flashcards.' });
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
                    'You are an expert study flashcard generator for a collaborative study room.',
                    'Analyze the combined study context and create 8 to 12 high-value flashcards.',
                    'Return only valid JSON. Do not include markdown, prose, explanations, or code fences.',
                    'Each flashcard must use this exact shape: {"front":"term or question","back":"definition or answer"}.',
                    `Combined study context:\n${combinedContext}`
                  ].join('\n\n')
                }
              ]
            }
          ]
        });

        const flashcards = parseFlashcardResponse(response.text);
        latestRoom.flashcards = flashcards;
        latestRoom.flashcardState = { index: 0, flipped: false };
        io.to(roomId).emit('flashcards_generated', {
          flashcards,
          state: latestRoom.flashcardState
        });
      } catch (error) {
        console.error('Gemini generate_flashcards error:', error);
        socket.emit('ai_response', { text: 'Sorry, I could not generate valid flashcards. Please try again.' });
      }
    });

    socket.on('flashcard_state_update', ({ index, flipped }) => {
      const latestRoom = rooms.get(roomId);
      if (!latestRoom || !Array.isArray(latestRoom.flashcards) || !latestRoom.flashcards.length) {
        return;
      }

      const nextIndex = Number.parseInt(index, 10);
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= latestRoom.flashcards.length) {
        return;
      }

      latestRoom.flashcardState = { index: nextIndex, flipped: Boolean(flipped) };
      io.to(roomId).emit('flashcard_state_update', latestRoom.flashcardState);
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

    socket.on('leave_room', ({ roomId: requestedRoomId } = {}) => {
      removeUserFromRoom(socket, requestedRoomId || roomId);
    });

    socket.on('disconnect', () => {
      removeUserFromRoom(socket, roomId);
      console.log(`User disconnected: ${socket.id}`);
    });
  });
});

const port = process.env.PORT || 5000;

server.listen(port, () => {
  console.log(`In-memory study room server running on port ${port}`);
});
