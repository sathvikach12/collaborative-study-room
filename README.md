# Collaborative Study Room & Real-Time AI Workspace

A production-grade, real-time web application engineered for collaborative group study, combining multi-user room synchronization, AI-powered tutoring, PDF document parsing, and interactive gamified study tools into a clean SaaS dashboard.

## Features

* **Real-Time Room Sync**: Isolate study groups into private rooms using **Socket.IO** to handle live multi-user text editing, instant chat broadcasting, and active participant presence tracking.
* **AI Study Assistant**: Powered by the official Gemini SDK (`gemini-3.6-flash`), students can query document explanations, ask complex concept questions, and receive targeted study summaries based on shared room context.
* **Multiplayer Quiz Generator**: Automatically converts parsed document text into structured, multiple-choice study quizzes using JSON parsing, featuring live room score tracking and leaderboards.
* **Integrated Productivity Tools**: Includes built-in Pomodoro focus timers, file upload handling for PDF notes, and a responsive 3-column dashboard layout.

## Tech Stack

* **Backend Runtime**: Node.js, Express.js
* **Real-Time Engine**: Socket.IO
* **Artificial Intelligence**: Google Gemini API (`@google/genai`)
* **Document Processing**: `pdf-parse`
* **Frontend Interface**: Vanilla JavaScript, HTML5, Tailwind CSS
* **Deployment**: Render

## Getting Started

### Prerequisites

Make sure you have Node.js and npm installed on your local machine.

### Installation & Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/sathvikach12/collaborative-study-room.git
   cd collaborative-study-room
