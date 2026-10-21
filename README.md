# CodeAlpha_TaskFlow — Project Management Web App

TaskFlow is a student-built project management application inspired by Kanban-style workflows used in tools such as Trello and Asana. It helps users organize projects, track tasks, and collaborate with project members through comments and live updates.

## Features

- User registration, sign-in, and sign-out
- Password hashing and session-based authentication
- Create and switch between projects
- Project membership and task assignment
- Kanban workflow with **To Do**, **In Progress**, and **Done** columns
- Create, edit, delete, and move tasks between statuses
- Task priorities and optional due dates
- Search and filter tasks
- Task comments and project activity history
- Real-time updates for shared project activity using Socket.IO
- SQLite database persistence
- Responsive interface for desktop and mobile screens

## Technology stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js, Express
- **Database:** SQLite with `better-sqlite3`
- **Authentication:** `bcryptjs`, `express-session`
- **Real-time communication:** Socket.IO

## Requirements

- Node.js LTS and npm
- Git (optional, for cloning and version control)

## Run locally

1. Clone the repository or download the source code.
2. Open a terminal in the project folder.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Set a unique session secret before starting the server. For PowerShell, use this in the same terminal:

   ```powershell
   $env:SESSION_SECRET = "replace-with-your-own-long-random-secret"
   ```

   Do not commit a real secret to GitHub. For a local-only demo, set a new value in your terminal before running the server.

5. Start TaskFlow:

   ```bash
   node server.js
   ```

6. Open [http://localhost:3000](http://localhost:3000) in your browser.

The SQLite database file is created locally by the server. This repository intentionally excludes local database files so test accounts and personal task data are not uploaded.

## Basic usage

1. Create an account or sign in.
2. Create a project and add tasks.
3. Set task priority and an optional due date.
4. Move tasks through the Kanban statuses.
5. Add members to a project and assign tasks.
6. Open comments and activity history to coordinate work with other members.
7. Test real-time updates by opening the same shared project in two separate browser sessions.

## Testing checklist

- Register, sign in, and sign out.
- Confirm a user's private projects are not visible to an unrelated account.
- Share a project with a second account and verify access.
- Create, update, assign, move, and delete tasks.
- Add comments and check the activity history.
- Open the same shared project in two browser sessions and verify live updates.
- Refresh the page and confirm persisted data remains available.


