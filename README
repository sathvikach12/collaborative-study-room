# Collaborative Study Room & Real-Time AI Workspace

A production-grade, real-time collaborative web application designed for group study sessions. It combines multi-user workspace synchronization, context-aware AI tutoring, and multiplayer gamified quizzes into a clean SaaS dashboard.

## Key Features

* **Real-Time Room Synchronization**: Built with **Socket.IO** to manage isolated rooms, enabling live multi-user note-editing, active user presence tracking, and instant group chat broadcasting.
* **Context-Aware AI Assistant**: Powered by the official `@google/genai` SDK (`gemini-3.6-flash`), allowing students to query concept explanations, summarize information, and receive study advice tailored directly to the live shared notes context.
* **Multiplayer Quiz Generator**: Automatically converts shared notes into custom-length, multiple-choice study quizzes using structured JSON output parsing, complete with individual score tracking and a live room leaderboard.
* **Responsive SaaS Dashboard**: Clean 3-column layout optimized for collaborative productivity and seamless user workflows.

## Tech Stack

* **Runtime**: Node.js, Express
* **Real-Time Communication**: Socket.IO
* **AI Integration**: `@google/genai` SDK (`gemini-3.6-flash`)
* **Frontend**: Vanilla JavaScript, HTML5, Tailwind CSS utilities
* **Environment & Tooling**: dotenv, nodemon

## Project Architecture

```text
collaborative-study-room/
├── public/
│   └── index.html         # 3-column SaaS dashboard and client-side socket logic
├── server.js              # Express server, Socket.IO event handlers, and Gemini integration
├── package.json           # Dependencies and scripts
├── .env                   # Environment variables (API keys)
└── README.md              # Project documentation