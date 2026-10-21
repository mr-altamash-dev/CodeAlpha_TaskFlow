const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Refuse to start with a public, predictable fallback session secret.
if (!process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is missing. Set it in your environment before starting TaskFlow.");
  process.exit(1);
}

const db = new Database(path.join(__dirname, "taskflow.db"));

db.pragma("foreign_keys = ON");

// Create the tables used by TaskFlow. Existing tables are kept and updated below.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    due_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`);

// Add columns introduced in later versions without deleting existing data.
function addColumnIfMissing(tableName, columnName, columnDefinition) {
  const columns = db.pragma(`table_info(${tableName})`);
  if (!columns.some(column => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

addColumnIfMissing("projects", "user_id", "INTEGER REFERENCES users(id)");
addColumnIfMissing("tasks", "assignee_id", "INTEGER REFERENCES users(id)");

db.exec(`
  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_task_assignee ON tasks(assignee_id);
  CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);
`);

// Comments and activity history belong to a project and are visible only to its members.
db.exec(`
  CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS project_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    task_id INTEGER,
    user_id INTEGER,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_comments_task_id ON task_comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_activity_project_id ON project_activity(project_id, id DESC);
`);

// Ensure the owner is listed as a member of each project they own.
db.prepare(`
  INSERT OR IGNORE INTO project_members (project_id, user_id, role)
  SELECT id, user_id, 'owner'
  FROM projects
  WHERE user_id IS NOT NULL
`).run();

if (db.prepare("SELECT COUNT(*) AS count FROM projects").get().count === 0) {
  db.prepare("INSERT INTO projects (name) VALUES (?)").run("My First Project");
}

app.use(express.json({ limit: "100kb" }));

// Share the same login session with normal API requests and Socket.IO.
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// Serve TaskFlow from Express so its API calls use the same origin.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));
app.get("/script.js", (req, res) => res.sendFile(path.join(__dirname, "script.js")));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "TaskFlow server is running" });
});

function startSession(req, res, user, statusCode = 200) {
  req.session.regenerate(error => {
    if (error) {
      console.error("Could not start session:", error);
      return res.status(500).json({ error: "Could not start a session." });
    }

    req.session.user = { id: user.id, name: user.name, email: user.email };

    req.session.save(saveError => {
      if (saveError) {
        console.error("Could not save session:", saveError);
        return res.status(500).json({ error: "Could not save the session." });
      }

      res.status(statusCode).json({ user: req.session.user });
    });
  });
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Please sign in to continue." });
  }
  next();
}

function findAccessibleProject(projectId, userId) {
  return db.prepare(`
    SELECT p.*
    FROM projects p
    WHERE p.id = ?
      AND (
        p.user_id = ?
        OR EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = p.id AND pm.user_id = ?
        )
      )
  `).get(projectId, userId, userId);
}

function isProjectMember(projectId, userId) {
  const project = db.prepare("SELECT user_id FROM projects WHERE id = ?").get(projectId);
  if (!project) return false;
  if (Number(project.user_id) === Number(userId)) return true;

  return Boolean(db.prepare(`
    SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?
  `).get(projectId, userId));
}

// Socket connections use the same authenticated session as the API.
io.use((socket, next) => {
  const sessionUser = socket.request.session?.user;

  if (!sessionUser) {
    return next(new Error("Please sign in to use live updates."));
  }

  const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?")
    .get(sessionUser.id);

  if (!user) {
    return next(new Error("Your account could not be verified."));
  }

  socket.data.user = {
    id: Number(user.id),
    name: user.name,
    email: user.email
  };

  next();
});

function userRoom(userId) {
  return `user:${Number(userId)}`;
}

function projectRoom(projectId) {
  return `project:${Number(projectId)}`;
}

function notifyProject(projectId, change, actorUserId) {
  io.to(projectRoom(projectId)).emit("project-updated", {
    projectId: String(projectId),
    change,
    actorUserId: Number(actorUserId),
    sentAt: Date.now()
  });
}

function notifyUserProjectsChanged(userId, details = {}) {
  io.to(userRoom(userId)).emit("projects-changed", details);
}

async function removeUserFromProjectSockets(projectId, userId) {
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  const room = projectRoom(projectId);

  for (const socket of sockets) {
    await socket.leave(room);
    socket.emit("project-removed", { projectId: String(projectId) });
  }
}

io.on("connection", socket => {
  const user = socket.data.user;
  socket.join(userRoom(user.id));

  socket.on("join-project", (payload, acknowledge) => {
    const projectId = Number(payload?.projectId);
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};

    if (!Number.isInteger(projectId) || projectId < 1 || !isProjectMember(projectId, user.id)) {
      reply({ ok: false, error: "You do not have access to this project." });
      socket.emit("project-access-denied", { projectId: String(payload?.projectId || "") });
      return;
    }

    // A browser tab only listens to the project currently open in that tab.
    for (const room of socket.rooms) {
      if (room.startsWith("project:")) {
        socket.leave(room);
      }
    }

    socket.join(projectRoom(projectId));
    reply({ ok: true, projectId: String(projectId) });
  });
});

function getTask(taskId, userId) {
  return db.prepare(`
    SELECT t.*, p.user_id AS projectOwnerId
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.id = ?
      AND (
        p.user_id = ?
        OR EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = p.id AND pm.user_id = ?
        )
      )
  `).get(taskId, userId, userId);
}

function taskResponse(task) {
  return {
    id: task.id,
    projectId: task.project_id,
    text: task.title,
    status: task.status,
    priority: task.priority,
    dueDate: task.due_date,
    createdAt: task.created_at,
    assigneeId: task.assigneeId ?? task.assignee_id ?? null,
    assigneeName: task.assigneeName ?? null,
    assigneeEmail: task.assigneeEmail ?? null,
    completed: task.status === "done"
  };
}

function logActivity(projectId, taskId, user, action, details) {
  db.prepare(`
    INSERT INTO project_activity
      (project_id, task_id, user_id, actor_name, action, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    taskId ?? null,
    user?.id ?? null,
    user?.name || "A team member",
    action,
    String(details).slice(0, 500)
  );
}

// Restore the signed-in user's details after a page refresh.
app.get("/api/auth/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?")
    .get(req.session.user.id);

  if (!user) {
    return req.session.destroy(() => res.status(401).json({ error: "Please sign in again." }));
  }

  res.json({ user });
});

// Create an account and hash its password before storing it.
app.post("/api/auth/register", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body.email === "string"
    ? req.body.email.trim().toLowerCase()
    : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (!name || name.length > 60) {
    return res.status(400).json({ error: "Name must contain 1–60 characters." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
    return res.status(400).json({ error: "Password must be at least 8 characters and no more than 72 bytes." });
  }

  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)"
    ).run(name, email, passwordHash);

    const user = { id: Number(result.lastInsertRowid), name, email };

    // The first account claims older projects which have no owner yet.
    db.prepare("UPDATE projects SET user_id = ? WHERE user_id IS NULL").run(user.id);
    db.prepare(`
      INSERT OR IGNORE INTO project_members (project_id, user_id, role)
      SELECT id, user_id, 'owner' FROM projects WHERE user_id IS NOT NULL
    `).run();

    const ownedProjectCount = db.prepare(
      "SELECT COUNT(*) AS count FROM projects WHERE user_id = ?"
    ).get(user.id).count;

    if (ownedProjectCount === 0) {
      const projectResult = db.prepare(
        "INSERT INTO projects (name, user_id) VALUES (?, ?)"
      ).run("My First Project", user.id);
      db.prepare(
        "INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')"
      ).run(projectResult.lastInsertRowid, user.id);
    }

    startSession(req, res, user, 201);
  } catch (error) {
    console.error("Registration failed:", error.message);
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    res.status(500).json({ error: "Could not create your account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = typeof req.body.email === "string"
    ? req.body.email.trim().toLowerCase()
    : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (!email || !password) {
    return res.status(400).json({ error: "Enter your email and password." });
  }

  try {
    const user = db.prepare(
      "SELECT id, name, email, password_hash FROM users WHERE email = ?"
    ).get(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    startSession(req, res, { id: user.id, name: user.name, email: user.email });
  } catch (error) {
    console.error("Login failed:", error.message);
    res.status(500).json({ error: "Could not sign in right now." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) return res.status(500).json({ error: "Could not sign out." });
    res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: false });
    res.json({ message: "Signed out successfully." });
  });
});

app.use("/api/projects", requireLogin);
app.use("/api/tasks", requireLogin);

// List projects owned by the user or shared with them.
app.get("/api/projects", (req, res) => {
  const userId = req.session.user.id;
  const projects = db.prepare(`
    SELECT p.id, p.name, p.created_at,
      CASE WHEN p.user_id = ? THEN 'owner' ELSE 'member' END AS role,
      COUNT(DISTINCT t.id) AS task_count,
      COUNT(DISTINCT pm.user_id) AS member_count
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    LEFT JOIN project_members pm ON pm.project_id = p.id
    WHERE p.user_id = ? OR EXISTS (
      SELECT 1 FROM project_members visible
      WHERE visible.project_id = p.id AND visible.user_id = ?
    )
    GROUP BY p.id
    ORDER BY p.id DESC
  `).all(userId, userId, userId);

  res.json(projects);
});

// Create a project and make its creator the owner.
app.post("/api/projects", (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 80) {
    return res.status(400).json({ error: "Project name must contain 1–80 characters." });
  }

  const createProject = db.transaction(() => {
    const result = db.prepare(
      "INSERT INTO projects (name, user_id) VALUES (?, ?)"
    ).run(name, req.session.user.id);

    db.prepare(
      "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')"
    ).run(result.lastInsertRowid, req.session.user.id);

    return db.prepare(
      "SELECT id, name, created_at FROM projects WHERE id = ?"
    ).get(result.lastInsertRowid);
  });

  const project = createProject();
  logActivity(project.id, null, req.session.user, "project_created", `Created project "${project.name}"`);
  notifyUserProjectsChanged(req.session.user.id, {
    reason: "project-created",
    projectId: String(project.id),
    actorUserId: Number(req.session.user.id)
  });
  res.status(201).json(project);
});

// Show the members of a project the user can access.
app.get("/api/projects/:projectId/members", (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || projectId < 1) {
    return res.status(400).json({ error: "Invalid project ID." });
  }

  const project = findAccessibleProject(projectId, req.session.user.id);
  if (!project) return res.status(404).json({ error: "Project not found." });

  const members = db.prepare(`
    SELECT u.id, u.name, u.email, pm.role, pm.created_at AS joinedAt
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ?
    ORDER BY CASE pm.role WHEN 'owner' THEN 0 ELSE 1 END, u.name COLLATE NOCASE
  `).all(projectId);

  res.json(members);
});

// Add an existing TaskFlow user to a project. Only the owner can add members.
app.post("/api/projects/:projectId/members", (req, res) => {
  const projectId = Number(req.params.projectId);
  const email = typeof req.body.email === "string"
    ? req.body.email.trim().toLowerCase()
    : "";

  if (!Number.isInteger(projectId) || projectId < 1) {
    return res.status(400).json({ error: "Invalid project ID." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const project = db.prepare("SELECT id, user_id FROM projects WHERE id = ?")
    .get(projectId);

  if (!project) return res.status(404).json({ error: "Project not found." });
  if (Number(project.user_id) !== Number(req.session.user.id)) {
    return res.status(403).json({ error: "Only the project owner can add members." });
  }

  const user = db.prepare("SELECT id, name, email FROM users WHERE email = ?").get(email);
  if (!user) {
    return res.status(404).json({ error: "No TaskFlow account uses that email. Ask them to register first." });
  }
  if (Number(user.id) === Number(req.session.user.id)) {
    return res.status(400).json({ error: "You already own this project." });
  }

  const result = db.prepare(`
    INSERT OR IGNORE INTO project_members (project_id, user_id, role)
    VALUES (?, ?, 'member')
  `).run(projectId, user.id);

  if (result.changes === 0) {
    return res.status(409).json({ error: "That user is already a project member." });
  }

  logActivity(projectId, null, req.session.user, "member_added", `Added ${user.name} to the project`);
  notifyProject(projectId, "member-added", req.session.user.id);
  notifyUserProjectsChanged(user.id, {
    reason: "added-to-project",
    projectId: String(projectId),
    actorUserId: Number(req.session.user.id)
  });

  res.status(201).json({
    message: `${user.name} was added to the project.`,
    member: { id: user.id, name: user.name, email: user.email, role: "member" }
  });
});

// An owner can remove a member; a member can leave a project themselves.
app.delete("/api/projects/:projectId/members/:memberId", (req, res) => {
  const projectId = Number(req.params.projectId);
  const memberId = Number(req.params.memberId);
  const currentUserId = Number(req.session.user.id);

  if (!Number.isInteger(projectId) || projectId < 1 || !Number.isInteger(memberId) || memberId < 1) {
    return res.status(400).json({ error: "Invalid project or member ID." });
  }

  const project = findAccessibleProject(projectId, currentUserId);
  if (!project) return res.status(404).json({ error: "Project not found." });

  if (Number(project.user_id) === memberId) {
    return res.status(400).json({ error: "The project owner cannot be removed." });
  }

  const isOwner = Number(project.user_id) === currentUserId;
  if (!isOwner && memberId !== currentUserId) {
    return res.status(403).json({ error: "Only the project owner can remove another member." });
  }

  const membership = db.prepare(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?"
  ).get(projectId, memberId);

  if (!membership || membership.role !== "member") {
    return res.status(404).json({ error: "Project member not found." });
  }

  const removedUser = db.prepare("SELECT name FROM users WHERE id = ?").get(memberId);
  const currentUser = req.session.user;
  const detail = memberId === currentUserId
    ? `${currentUser.name} left the project`
    : `${removedUser?.name || "A member"} was removed from the project`;

  const removeMember = db.transaction(() => {
    db.prepare(
      "UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?"
    ).run(projectId, memberId);
    db.prepare(
      "DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role = 'member'"
    ).run(projectId, memberId);
    logActivity(projectId, null, currentUser, "member_removed", detail);
  });

  removeMember();
  notifyProject(projectId, "member-removed", currentUserId);
  removeUserFromProjectSockets(projectId, memberId).catch(error => {
    console.error("Could not update removed member's live connections:", error.message);
  });
  notifyUserProjectsChanged(memberId, {
    reason: "removed-from-project",
    projectId: String(projectId),
    actorUserId: currentUserId
  });
  res.json({ message: "Member removed from the project." });
});

// Show recent changes for a project the user can access.
app.get("/api/projects/:projectId/activity", (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || projectId < 1) {
    return res.status(400).json({ error: "Invalid project ID." });
  }

  if (!findAccessibleProject(projectId, req.session.user.id)) {
    return res.status(404).json({ error: "Project not found." });
  }

  const activity = db.prepare(`
    SELECT
      a.id,
      a.project_id AS projectId,
      a.task_id AS taskId,
      a.actor_name AS actorName,
      a.action,
      a.details,
      a.created_at AS createdAt,
      t.title AS taskTitle
    FROM project_activity a
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.project_id = ?
    ORDER BY a.id DESC
    LIMIT 40
  `).all(projectId);

  res.json(activity);
});

// List comments for a task visible to the signed-in user.
app.get("/api/tasks/:taskId/comments", (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) {
    return res.status(400).json({ error: "Invalid task ID." });
  }

  const task = getTask(taskId, req.session.user.id);
  if (!task) return res.status(404).json({ error: "Task not found." });

  const comments = db.prepare(`
    SELECT c.id, c.task_id AS taskId, c.user_id AS userId,
      u.name AS authorName, c.body, c.created_at AS createdAt
    FROM task_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ?
    ORDER BY c.id ASC
  `).all(taskId);

  res.json(comments);
});

// Post a comment and add an entry to the project activity history.
app.post("/api/tasks/:taskId/comments", (req, res) => {
  const taskId = Number(req.params.taskId);
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";

  if (!Number.isInteger(taskId) || taskId < 1) {
    return res.status(400).json({ error: "Invalid task ID." });
  }
  if (!body || body.length > 2000) {
    return res.status(400).json({ error: "Comment must contain 1–2000 characters." });
  }

  const task = getTask(taskId, req.session.user.id);
  if (!task) return res.status(404).json({ error: "Task not found." });

  const user = req.session.user;
  const addComment = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO task_comments (task_id, user_id, body)
      VALUES (?, ?, ?)
    `).run(taskId, user.id, body);

    logActivity(
      task.project_id,
      taskId,
      user,
      "comment_added",
      `Commented on "${task.title}"`
    );

    return db.prepare(`
      SELECT c.id, c.task_id AS taskId, c.user_id AS userId,
        u.name AS authorName, c.body, c.created_at AS createdAt
      FROM task_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `).get(result.lastInsertRowid);
  });

  const comment = addComment();
  notifyProject(task.project_id, "comment-added", user.id);
  res.status(201).json(comment);
});

app.get("/api/projects/:projectId/tasks", (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || projectId < 1) {
    return res.status(400).json({ error: "Invalid project ID." });
  }

  if (!findAccessibleProject(projectId, req.session.user.id)) {
    return res.status(404).json({ error: "Project not found." });
  }

  const tasks = db.prepare(`
    SELECT t.id, t.project_id AS projectId, t.title AS text,
      t.status, t.priority, t.due_date AS dueDate, t.created_at AS createdAt,
      t.assignee_id AS assigneeId, u.name AS assigneeName, u.email AS assigneeEmail
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = ?
    ORDER BY t.id DESC
  `).all(projectId);

  res.json(tasks.map(task => ({ ...task, completed: task.status === "done" })));
});

app.post("/api/projects/:projectId/tasks", (req, res) => {
  const projectId = Number(req.params.projectId);
  const value = req.body.text ?? req.body.title;
  const title = typeof value === "string" ? value.trim() : "";
  const priority = req.body.priority ?? "medium";
  const status = req.body.status ?? "todo";
  const dueDate = req.body.dueDate || null;
  let assigneeId = req.body.assigneeId ?? null;

  if (!Number.isInteger(projectId) || projectId < 1) {
    return res.status(400).json({ error: "Invalid project ID." });
  }
  if (!title || title.length > 120) {
    return res.status(400).json({ error: "Task name must contain 1–120 characters." });
  }
  if (!["low", "medium", "high"].includes(priority)) {
    return res.status(400).json({ error: "Invalid priority." });
  }
  if (!["todo", "in-progress", "done"].includes(status)) {
    return res.status(400).json({ error: "Invalid task status." });
  }
  if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) {
    return res.status(400).json({ error: "Invalid due date." });
  }
  if (assigneeId !== null) {
    assigneeId = Number(assigneeId);
    if (!Number.isInteger(assigneeId) || assigneeId < 1) {
      return res.status(400).json({ error: "Invalid assignee." });
    }
  }

  const project = findAccessibleProject(projectId, req.session.user.id);
  if (!project) return res.status(404).json({ error: "Project not found." });

  if (assigneeId !== null && !isProjectMember(projectId, assigneeId)) {
    return res.status(400).json({ error: "Assignee must be a member of this project." });
  }

  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, status, priority, due_date, assignee_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, title, status, priority, dueDate, assigneeId);

  const task = db.prepare(`
    SELECT t.id, t.project_id AS projectId, t.title AS text,
      t.status, t.priority, t.due_date AS dueDate, t.created_at AS createdAt,
      t.assignee_id AS assigneeId, u.name AS assigneeName, u.email AS assigneeEmail
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?
  `).get(result.lastInsertRowid);

  logActivity(projectId, task.id, req.session.user, "task_created", `Created task "${task.text}"`);
  notifyProject(projectId, "task-created", req.session.user.id);
  res.status(201).json({ ...task, completed: task.status === "done" });
});

app.patch("/api/tasks/:taskId", (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) {
    return res.status(400).json({ error: "Invalid task ID." });
  }

  const task = getTask(taskId, req.session.user.id);
  if (!task) return res.status(404).json({ error: "Task not found." });

  const body = req.body;
  const titleValue = body.text ?? body.title ?? task.title;
  const title = typeof titleValue === "string" ? titleValue.trim() : "";
  let status = body.status ?? task.status;

  if (body.completed !== undefined && body.status === undefined) {
    status = body.completed ? "done" : "todo";
  }

  const priority = body.priority ?? task.priority;
  const dueDate = Object.prototype.hasOwnProperty.call(body, "dueDate")
    ? (body.dueDate || null)
    : task.due_date;
  let assigneeId = Object.prototype.hasOwnProperty.call(body, "assigneeId")
    ? body.assigneeId
    : task.assignee_id;

  if (!title || title.length > 120) {
    return res.status(400).json({ error: "Task name must contain 1–120 characters." });
  }
  if (!["todo", "in-progress", "done"].includes(status)) {
    return res.status(400).json({ error: "Invalid task status." });
  }
  if (!["low", "medium", "high"].includes(priority)) {
    return res.status(400).json({ error: "Invalid priority." });
  }
  if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) {
    return res.status(400).json({ error: "Invalid due date." });
  }
  if (assigneeId === "" || assigneeId === null || assigneeId === undefined) {
    assigneeId = null;
  } else {
    assigneeId = Number(assigneeId);
    if (!Number.isInteger(assigneeId) || assigneeId < 1) {
      return res.status(400).json({ error: "Invalid assignee." });
    }
    if (!isProjectMember(task.project_id, assigneeId)) {
      return res.status(400).json({ error: "Assignee must be a member of this project." });
    }
  }

  const activityChanges = [];
  if (title !== task.title) activityChanges.push(`Renamed task to "${title}"`);
  if (status !== task.status) {
    const statusNames = { todo: "To Do", "in-progress": "In Progress", done: "Done" };
    activityChanges.push(`Moved "${title}" to ${statusNames[status]}`);
  }
  if (priority !== task.priority) activityChanges.push(`Changed priority of "${title}" to ${priority}`);
  if (dueDate !== task.due_date) {
    activityChanges.push(dueDate ? `Set a due date for "${title}"` : `Removed the due date from "${title}"`);
  }
  if (Number(assigneeId || 0) !== Number(task.assignee_id || 0)) {
    const assignedUser = assigneeId === null
      ? null
      : db.prepare("SELECT name FROM users WHERE id = ?").get(assigneeId);
    activityChanges.push(assignedUser
      ? `Assigned "${title}" to ${assignedUser.name}`
      : `Removed the assignee from "${title}"`);
  }

  db.prepare(`
    UPDATE tasks
    SET title = ?, status = ?, priority = ?, due_date = ?, assignee_id = ?
    WHERE id = ?
  `).run(title, status, priority, dueDate, assigneeId, taskId);

  if (activityChanges.length) {
    logActivity(task.project_id, taskId, req.session.user, "task_updated", activityChanges.join(" · "));
  }

  const updatedTask = db.prepare(`
    SELECT t.id, t.project_id AS projectId, t.title AS text,
      t.status, t.priority, t.due_date AS dueDate, t.created_at AS createdAt,
      t.assignee_id AS assigneeId, u.name AS assigneeName, u.email AS assigneeEmail
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?
  `).get(taskId);

  notifyProject(task.project_id, "task-updated", req.session.user.id);
  res.json({ ...updatedTask, completed: updatedTask.status === "done" });
});

app.delete("/api/tasks/:taskId", (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) {
    return res.status(400).json({ error: "Invalid task ID." });
  }

  const task = getTask(taskId, req.session.user.id);
  if (!task) return res.status(404).json({ error: "Task not found." });

  logActivity(task.project_id, taskId, req.session.user, "task_deleted", `Deleted task "${task.title}"`);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  notifyProject(task.project_id, "task-deleted", req.session.user.id);
  res.json({ message: "Task deleted successfully." });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use((err, req, res, next) => {
  console.error(err.message);
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ error: "Invalid JSON request." });
  }
  res.status(500).json({ error: "Something went wrong on the server." });
});

server.listen(PORT, () => {
  console.log(`TaskFlow server running at http://localhost:${PORT}`);
  console.log("Live collaboration is enabled (Socket.IO).");
});
