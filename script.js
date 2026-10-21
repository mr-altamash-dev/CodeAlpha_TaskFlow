const authScreen = document.getElementById("auth-screen");
const authTitle = document.getElementById("auth-title");
const authDescription = document.getElementById("auth-description");
const authMessage = document.getElementById("auth-message");
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const authSwitchPrompt = document.getElementById("auth-switch-prompt");
const authSwitchButton = document.getElementById("auth-switch-button");
const appScreen = document.getElementById("app");
const loggedInName = document.getElementById("logged-in-name");
const logoutButton = document.getElementById("logout-button");
const realtimeStatus = document.getElementById("realtime-status");

const projectSelect = document.getElementById("project-select");
const projectTitle = document.getElementById("current-project-title");
const newProjectButton = document.getElementById("new-project");
const taskInput = document.getElementById("task-input");
const addTaskButton = document.getElementById("add-task");
const prioritySelect = document.getElementById("task-priority");
const dueDateInput = document.getElementById("task-due-date");
const searchInput = document.getElementById("task-search");
const taskCount = document.getElementById("task-count");
const filterButtons = document.querySelectorAll(".filter-button");

const membersList = document.getElementById("members-list");
const memberCount = document.getElementById("member-count");
const addMemberForm = document.getElementById("add-member-form");
const memberEmailInput = document.getElementById("member-email");
const addMemberButton = document.getElementById("add-member-button");
const memberMessage = document.getElementById("member-message");
const activityList = document.getElementById("activity-list");
const refreshActivityButton = document.getElementById("refresh-activity");
const openCommentTaskIds = new Set();

const PROJECT_KEY_PREFIX = "taskflow-current-project-api-";
const LEGACY_PROJECT_KEY = "taskflow-current-project-api";
const statuses = [
  { value: "todo", label: "To Do", listId: "list-todo", countId: "count-todo" },
  { value: "in-progress", label: "In Progress", listId: "list-in-progress", countId: "count-in-progress" },
  { value: "done", label: "Done", listId: "list-done", countId: "count-done" }
];

let currentUser = null;
let projects = [];
let currentProjectId = "";
let currentFilter = "all";
let authMode = "login";
let realtimeSocket = null;
let liveRefreshTimer = null;

function projectStorageKey() {
  return currentUser ? `${PROJECT_KEY_PREFIX}${currentUser.id}` : PROJECT_KEY_PREFIX;
}

function setRealtimeStatus(state, message) {
  if (!realtimeStatus) return;
  realtimeStatus.dataset.state = state;
  realtimeStatus.textContent = message;
  realtimeStatus.title = message;
}

function joinCurrentProjectRoom() {
  if (!realtimeSocket?.connected || !currentProjectId) return;

  realtimeSocket.emit("join-project", { projectId: currentProjectId }, result => {
    if (!result?.ok) {
      console.warn("Could not join the live project room:", result?.error);
    }
  });
}

function refreshAfterLiveUpdate(projectId) {
  if (!currentUser) return;

  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(async function () {
    try {
      await loadProjects(projectId || currentProjectId);
    } catch (error) {
      console.error("Could not refresh live project changes:", error);
    }
  }, 120);
}

function connectRealtime() {
  if (typeof window.io !== "function") {
    setRealtimeStatus("offline", "Live updates unavailable");
    return;
  }

  if (!realtimeSocket) {
    realtimeSocket = window.io({ autoConnect: false });

    realtimeSocket.on("connect", function () {
      setRealtimeStatus("online", "Live updates connected");
      joinCurrentProjectRoom();
    });

    realtimeSocket.on("disconnect", function () {
      setRealtimeStatus("offline", "Live updates reconnecting");
    });

    realtimeSocket.on("connect_error", function (error) {
      setRealtimeStatus("offline", "Live updates unavailable");
      console.warn("Live updates could not connect:", error.message);
    });

    realtimeSocket.on("project-updated", function (change) {
      if (!currentUser || String(change.projectId) !== String(currentProjectId)) {
        return;
      }

      // The tab that made the change already refreshes after its API request.
      if (Number(change.actorUserId) === Number(currentUser.id)) {
        return;
      }

      refreshAfterLiveUpdate(currentProjectId);
    });

    realtimeSocket.on("projects-changed", function (change = {}) {
      if (!currentUser) return;
      if (Number(change.actorUserId) === Number(currentUser.id)) return;
      if (change.reason === "removed-from-project") return;
      refreshAfterLiveUpdate(currentProjectId);
    });

    realtimeSocket.on("project-removed", async function (change) {
      if (!currentUser) return;

      const wasCurrentProject = String(change.projectId) === String(currentProjectId);

      try {
        await loadProjects(wasCurrentProject ? "" : currentProjectId);
        if (wasCurrentProject) {
          memberMessage.textContent = "You no longer have access to that project.";
          memberMessage.className = "member-message error";
        }
      } catch (error) {
        console.error("Could not refresh after project access changed:", error);
      }
    });

    realtimeSocket.on("project-access-denied", function () {
      setRealtimeStatus("offline", "Project access changed; reconnecting");
      refreshAfterLiveUpdate("");
    });
  }

  if (!realtimeSocket.connected) {
    realtimeSocket.connect();
  }
}

function disconnectRealtime() {
  if (realtimeSocket?.connected) {
    realtimeSocket.disconnect();
  }
  setRealtimeStatus("offline", "Live updates offline");
}

async function apiRequest(url, options = {}) {
  const requestOptions = {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.headers || {}) }
  };

  if (options.body) {
    requestOptions.headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, requestOptions);
  let data = {};

  try {
    data = await response.json();
  } catch {
    // The response did not include JSON.
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }

  return data;
}

function showAuthMessage(message, type = "error") {
  authMessage.textContent = message;
  authMessage.className = `auth-message ${type}`;
}

function setAuthMode(mode) {
  authMode = mode;
  authMessage.textContent = "";
  authMessage.className = "auth-message";

  const registering = mode === "register";
  loginForm.hidden = registering;
  registerForm.hidden = !registering;
  authTitle.textContent = registering ? "Create your account" : "Welcome back";
  authDescription.textContent = registering
    ? "Create an account to start organizing your projects."
    : "Sign in to manage your projects and tasks.";
  authSwitchPrompt.textContent = registering
    ? "Already have an account?"
    : "New to TaskFlow?";
  authSwitchButton.textContent = registering ? "Sign in" : "Create an account";
}

function showApp(user) {
  currentUser = user;
  connectRealtime();
  authScreen.hidden = true;
  appScreen.hidden = false;
  loggedInName.textContent = user.name;

  // Each account remembers its own selected project.
  const savedProjectId = localStorage.getItem(projectStorageKey())
    || localStorage.getItem(LEGACY_PROJECT_KEY)
    || "";
  loadProjects(savedProjectId).catch(error => {
    console.error("Could not load projects:", error);
    alert(`Could not load your projects: ${error.message}`);
  });
}

function showLoginScreen() {
  disconnectRealtime();
  appScreen.hidden = true;
  authScreen.hidden = false;
  loggedInName.textContent = "";
  currentUser = null;
  projects = [];
  currentProjectId = "";
  setAuthMode("login");
}

async function submitAuthForm(event, mode) {
  event.preventDefault();
  showAuthMessage(mode === "register" ? "Creating your account…" : "Signing in…", "success");

  const form = mode === "register" ? registerForm : loginForm;
  const formButton = form.querySelector('button[type="submit"]');
  formButton.disabled = true;

  const body = mode === "register"
    ? {
        name: document.getElementById("register-name").value.trim(),
        email: document.getElementById("register-email").value.trim(),
        password: document.getElementById("register-password").value
      }
    : {
        email: document.getElementById("login-email").value.trim(),
        password: document.getElementById("login-password").value
      };

  try {
    const result = await apiRequest(`/api/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    form.reset();
    showApp(result.user);
  } catch (error) {
    showAuthMessage(error.message);
  } finally {
    formButton.disabled = false;
  }
}

loginForm.addEventListener("submit", event => submitAuthForm(event, "login"));
registerForm.addEventListener("submit", event => submitAuthForm(event, "register"));

authSwitchButton.addEventListener("click", function () {
  setAuthMode(authMode === "login" ? "register" : "login");
});

async function loadProjects(preferredProjectId = currentProjectId) {
  const rows = await apiRequest("/api/projects");

  if (rows.length === 0) {
    const newProject = await apiRequest("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "My First Project" })
    });
    rows.push(newProject);
  }

  projects = await Promise.all(rows.map(async function (row) {
    const [tasks, members] = await Promise.all([
      apiRequest(`/api/projects/${row.id}/tasks`),
      apiRequest(`/api/projects/${row.id}/members`)
    ]);

    return {
      id: String(row.id),
      name: row.name,
      role: row.role || "owner",
      tasks,
      members
    };
  }));

  const preferredId = String(preferredProjectId || "");
  currentProjectId = projects.some(project => project.id === preferredId)
    ? preferredId
    : projects[0].id;

  localStorage.setItem(projectStorageKey(), currentProjectId);
  renderProjectSelector();
  renderMembers();
  renderBoard();
  await loadActivity();
  joinCurrentProjectRoom();
}

function getCurrentProject() {
  return projects.find(project => project.id === currentProjectId);
}

function getToday() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function formatTimestamp(value) {
  if (!value) return "Just now";

  // SQLite timestamps are stored in UTC without a timezone suffix.
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

async function loadActivity() {
  const project = getCurrentProject();
  activityList.replaceChildren();

  if (!project) {
    const item = document.createElement("li");
    item.className = "activity-empty";
    item.textContent = "Select a project to see its activity.";
    activityList.appendChild(item);
    return;
  }

  try {
    const activity = await apiRequest(`/api/projects/${project.id}/activity`);

    if (activity.length === 0) {
      const item = document.createElement("li");
      item.className = "activity-empty";
      item.textContent = "No activity yet. Changes and comments will appear here.";
      activityList.appendChild(item);
      return;
    }

    activity.forEach(function (entry) {
      const item = document.createElement("li");
      item.className = "activity-item";

      const marker = document.createElement("span");
      marker.className = "activity-marker";
      marker.setAttribute("aria-hidden", "true");

      const content = document.createElement("div");
      content.className = "activity-content";

      const details = document.createElement("p");
      details.className = "activity-details";

      const actor = document.createElement("strong");
      actor.textContent = entry.actorName || "A team member";
      details.append(actor, document.createTextNode(` ${entry.details}`));

      const date = document.createElement("time");
      date.className = "activity-date";
      date.dateTime = entry.createdAt || "";
      date.textContent = formatTimestamp(entry.createdAt);

      content.append(details, date);
      item.append(marker, content);
      activityList.appendChild(item);
    });
  } catch (error) {
    const item = document.createElement("li");
    item.className = "activity-empty activity-error";
    item.textContent = `Could not load activity: ${error.message}`;
    activityList.appendChild(item);
  }
}

async function loadComments(taskId, panel) {
  panel.replaceChildren();

  const heading = document.createElement("h5");
  heading.className = "comments-title";
  heading.textContent = "Comments";
  panel.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "comments-list";
  list.setAttribute("aria-live", "polite");
  panel.appendChild(list);

  const loading = document.createElement("li");
  loading.className = "comments-empty";
  loading.textContent = "Loading comments…";
  list.appendChild(loading);

  try {
    const comments = await apiRequest(`/api/tasks/${taskId}/comments`);
    list.replaceChildren();

    if (comments.length === 0) {
      const empty = document.createElement("li");
      empty.className = "comments-empty";
      empty.textContent = "No comments yet. Start the conversation.";
      list.appendChild(empty);
    } else {
      comments.forEach(function (comment) {
        const item = document.createElement("li");
        item.className = "comment-item";

        const header = document.createElement("div");
        header.className = "comment-header";

        const author = document.createElement("strong");
        author.textContent = comment.authorName;

        const date = document.createElement("time");
        date.className = "comment-date";
        date.textContent = formatTimestamp(comment.createdAt);
        date.dateTime = comment.createdAt || "";

        const body = document.createElement("p");
        body.className = "comment-body";
        body.textContent = comment.body;

        header.append(author, date);
        item.append(header, body);
        list.appendChild(item);
      });
    }

    const form = document.createElement("form");
    form.className = "comment-form";

    const input = document.createElement("textarea");
    input.className = "comment-input";
    input.name = "comment";
    input.rows = 2;
    input.maxLength = 2000;
    input.placeholder = "Write a comment…";
    input.setAttribute("aria-label", "Write a comment");
    input.required = true;

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Post comment";

    const message = document.createElement("p");
    message.className = "comment-message";
    message.setAttribute("role", "status");

    form.append(input, submit);
    panel.append(form, message);

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      const body = input.value.trim();
      if (!body) return;

      submit.disabled = true;
      message.textContent = "Posting…";

      try {
        await apiRequest(`/api/tasks/${taskId}/comments`, {
          method: "POST",
          body: JSON.stringify({ body })
        });
        await loadComments(taskId, panel);
        await loadActivity();
      } catch (error) {
        message.textContent = error.message;
        submit.disabled = false;
      }
    });
  } catch (error) {
    list.replaceChildren();
    const item = document.createElement("li");
    item.className = "comments-empty activity-error";
    item.textContent = `Could not load comments: ${error.message}`;
    list.appendChild(item);
  }
}

function renderProjectSelector() {
  projectSelect.replaceChildren();

  projects.forEach(function (project) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.role === "member"
      ? `${project.name} · shared`
      : project.name;
    projectSelect.appendChild(option);
  });

  projectSelect.value = currentProjectId;
  projectTitle.textContent = getCurrentProject()?.name || "No project";
}

function renderMembers() {
  const project = getCurrentProject();
  membersList.replaceChildren();
  memberMessage.textContent = "";

  if (!project) {
    memberCount.textContent = "0";
    addMemberForm.hidden = true;
    return;
  }

  memberCount.textContent = String(project.members.length);
  addMemberForm.hidden = project.role !== "owner";

  if (project.role === "owner") {
    memberMessage.textContent = "Add people who already have a TaskFlow account.";
  } else {
    memberMessage.textContent = "Only the project owner can add or remove members.";
  }

  project.members.forEach(function (member) {
    const chip = document.createElement("div");
    chip.className = "member-chip";

    const details = document.createElement("div");
    details.className = "member-details";

    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = member.name;

    const email = document.createElement("span");
    email.className = "member-email";
    email.textContent = member.email;

    details.append(name, email);

    const role = document.createElement("span");
    role.className = `member-role ${member.role === "owner" ? "owner-role" : ""}`;
    role.textContent = member.role === "owner" ? "Owner" : "Member";

    chip.append(details, role);

    const ownerCanRemove = project.role === "owner" && member.role === "member";
    const memberCanLeave = project.role === "member" && String(member.id) === String(currentUser.id);

    if (ownerCanRemove || memberCanLeave) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "remove-member-button";
      removeButton.textContent = memberCanLeave ? "Leave" : "Remove";
      removeButton.setAttribute(
        "aria-label",
        memberCanLeave ? "Leave this project" : `Remove ${member.name} from project`
      );
      removeButton.addEventListener("click", function () {
        removeMember(member);
      });
      chip.appendChild(removeButton);
    }

    membersList.appendChild(chip);
  });
}

async function addMember(event) {
  event.preventDefault();
  const project = getCurrentProject();
  if (!project || project.role !== "owner") return;

  const email = memberEmailInput.value.trim();
  if (!email) return;

  addMemberButton.disabled = true;
  memberMessage.textContent = "Adding member…";
  memberMessage.className = "member-message";

  try {
    const result = await apiRequest(`/api/projects/${project.id}/members`, {
      method: "POST",
      body: JSON.stringify({ email })
    });

    memberEmailInput.value = "";
    await loadProjects(project.id);
    memberMessage.textContent = result.message;
    memberMessage.className = "member-message success";
  } catch (error) {
    memberMessage.textContent = error.message;
    memberMessage.className = "member-message error";
  } finally {
    addMemberButton.disabled = false;
  }
}

async function removeMember(member) {
  const project = getCurrentProject();
  if (!project) return;

  const canRemoveMember = project.role === "owner" && member.role === "member";
  const canLeaveProject = project.role === "member" && String(member.id) === String(currentUser.id);

  if (!canRemoveMember && !canLeaveProject) return;

  const confirmation = canLeaveProject
    ? "Leave this project? Tasks assigned to you will become unassigned."
    : `Remove ${member.name} from this project? Their assigned tasks will become unassigned.`;

  if (!confirm(confirmation)) return;

  try {
    await apiRequest(`/api/projects/${project.id}/members/${member.id}`, {
      method: "DELETE"
    });
    await loadProjects(project.id);
    memberMessage.textContent = canLeaveProject
      ? "You left the project."
      : `${member.name} was removed from the project.`;
    memberMessage.className = "member-message success";
  } catch (error) {
    memberMessage.textContent = error.message;
    memberMessage.className = "member-message error";
  }
}

function renderBoard() {
  const project = getCurrentProject();

  if (!project) {
    taskCount.textContent = "0 tasks";
    statuses.forEach(function (status) {
      document.getElementById(status.listId).replaceChildren();
      document.getElementById(status.countId).textContent = "0";
    });
    return;
  }

  const searchText = searchInput.value.trim().toLowerCase();
  const visibleTasks = project.tasks.filter(function (task) {
    const matchesSearch = task.text.toLowerCase().includes(searchText);
    const matchesFilter = currentFilter === "active"
      ? task.status !== "done"
      : currentFilter === "completed"
        ? task.status === "done"
        : true;

    return matchesSearch && matchesFilter;
  });

  taskCount.textContent = `${project.tasks.length} ${project.tasks.length === 1 ? "task" : "tasks"}`;

  filterButtons.forEach(function (button) {
    const selected = button.dataset.filter === currentFilter;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  statuses.forEach(function (status) {
    const list = document.getElementById(status.listId);
    const count = document.getElementById(status.countId);
    const tasksForColumn = visibleTasks.filter(task => task.status === status.value);

    list.replaceChildren();
    count.textContent = tasksForColumn.length;

    if (tasksForColumn.length === 0) {
      const message = document.createElement("li");
      message.className = "empty-column";
      message.textContent = searchText || currentFilter !== "all"
        ? "No matching tasks."
        : "No tasks here yet.";
      list.appendChild(message);
      return;
    }

    tasksForColumn.forEach(task => list.appendChild(createTaskCard(task, project)));
  });
}

function createTaskCard(task, project) {
  const card = document.createElement("li");
  card.className = "task-card";

  if (task.status === "done") card.classList.add("completed");

  const title = document.createElement("h4");
  title.className = "task-title";
  title.textContent = task.text;
  card.appendChild(title);

  const statusLabel = document.createElement("label");
  const statusSelect = document.createElement("select");
  statusSelect.id = `status-${task.id}`;
  statusLabel.htmlFor = statusSelect.id;
  statusLabel.textContent = "Move task";
  statusSelect.className = "task-status";

  statuses.forEach(function (status) {
    const option = document.createElement("option");
    option.value = status.value;
    option.textContent = status.label;
    statusSelect.appendChild(option);
  });

  statusSelect.value = task.status;
  statusSelect.addEventListener("change", function () {
    updateTask(task.id, { status: statusSelect.value });
  });
  card.append(statusLabel, statusSelect);

  // Let a project member assign the task to another project member.
  const assigneeLabel = document.createElement("label");
  const assigneeSelect = document.createElement("select");
  assigneeSelect.id = `assignee-${task.id}`;
  assigneeLabel.htmlFor = assigneeSelect.id;
  assigneeLabel.textContent = "Assigned to";
  assigneeSelect.className = "task-assignee";

  const unassignedOption = document.createElement("option");
  unassignedOption.value = "";
  unassignedOption.textContent = "Unassigned";
  assigneeSelect.appendChild(unassignedOption);

  project.members.forEach(function (member) {
    const option = document.createElement("option");
    option.value = String(member.id);
    option.textContent = member.id === task.assigneeId
      ? `${member.name} (assigned)`
      : member.name;
    assigneeSelect.appendChild(option);
  });

  assigneeSelect.value = task.assigneeId ? String(task.assigneeId) : "";
  assigneeSelect.addEventListener("change", function () {
    const value = assigneeSelect.value;
    updateTask(task.id, { assigneeId: value ? Number(value) : null });
  });

  card.append(assigneeLabel, assigneeSelect);

  const details = document.createElement("div");
  details.className = "task-details";

  const priority = document.createElement("span");
  priority.className = `priority-badge priority-${task.priority}`;
  priority.textContent = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
  details.appendChild(priority);

  if (task.dueDate) {
    const dueDate = document.createElement("span");
    dueDate.className = "due-date";
    dueDate.textContent = `Due: ${formatDate(task.dueDate)}`;
    if (task.dueDate < getToday() && task.status !== "done") {
      dueDate.classList.add("overdue");
    }
    details.appendChild(dueDate);
  }

  card.appendChild(details);

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "edit-task";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", async function () {
    const newText = prompt("Edit task:", task.text);
    if (newText === null) return;

    const cleanedText = newText.trim();
    if (!cleanedText) {
      alert("Task name cannot be empty.");
      return;
    }

    await updateTask(task.id, { text: cleanedText });
  });

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-task";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async function () {
    if (!confirm(`Delete "${task.text}"?`)) return;

    try {
      await apiRequest(`/api/tasks/${task.id}`, { method: "DELETE" });
      await loadProjects(currentProjectId);
    } catch (error) {
      alert(`Could not delete task: ${error.message}`);
    }
  });

  actions.append(editButton, deleteButton);
  card.appendChild(actions);

  const commentsButton = document.createElement("button");
  commentsButton.type = "button";
  commentsButton.className = "comments-toggle";
  commentsButton.textContent = "Comments";
  commentsButton.setAttribute("aria-expanded", "false");
  commentsButton.setAttribute("aria-label", `Show comments for ${task.text}`);
  commentsButton.addEventListener("click", async function () {
    const panel = card.querySelector(".comments-panel");
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    commentsButton.textContent = willOpen ? "Hide comments" : "Comments";
    commentsButton.setAttribute("aria-expanded", String(willOpen));

    if (willOpen) {
      openCommentTaskIds.add(String(task.id));
      await loadComments(task.id, panel);
    } else {
      openCommentTaskIds.delete(String(task.id));
    }
  });

  const commentsPanel = document.createElement("section");
  commentsPanel.className = "comments-panel";
  commentsPanel.hidden = !openCommentTaskIds.has(String(task.id));
  card.append(commentsButton, commentsPanel);

  if (!commentsPanel.hidden) {
    commentsButton.textContent = "Hide comments";
    commentsButton.setAttribute("aria-expanded", "true");
    loadComments(task.id, commentsPanel);
  }

  return card;
}

async function updateTask(taskId, changes) {
  try {
    await apiRequest(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(changes)
    });
    await loadProjects(currentProjectId);
  } catch (error) {
    alert(`Could not update task: ${error.message}`);
  }
}

async function addTask() {
  const text = taskInput.value.trim();
  if (!text) {
    taskInput.focus();
    return;
  }
  if (!currentProjectId) {
    alert("Create a project before adding tasks.");
    return;
  }

  try {
    await apiRequest(`/api/projects/${currentProjectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        text,
        status: "todo",
        priority: prioritySelect.value,
        dueDate: dueDateInput.value || null
      })
    });

    taskInput.value = "";
    prioritySelect.value = "medium";
    dueDateInput.value = "";
    searchInput.value = "";
    currentFilter = "all";

    await loadProjects(currentProjectId);
    taskInput.focus();
  } catch (error) {
    alert(`Could not add task: ${error.message}`);
  }
}

async function createProject() {
  const enteredName = prompt("Enter a name for your new project:");
  if (enteredName === null) return;

  const name = enteredName.trim();
  if (!name) {
    alert("Project name cannot be empty.");
    return;
  }

  try {
    const project = await apiRequest("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    currentFilter = "all";
    searchInput.value = "";
    await loadProjects(String(project.id));
  } catch (error) {
    alert(`Could not create project: ${error.message}`);
  }
}

async function handleProjectChange() {
  currentProjectId = projectSelect.value;
  currentFilter = "all";
  searchInput.value = "";
  localStorage.setItem(projectStorageKey(), currentProjectId);

  try {
    await loadProjects(currentProjectId);
  } catch (error) {
    alert(`Could not open project: ${error.message}`);
  }
}

async function handleAddMember(event) {
  event.preventDefault();
  await addMember(event);
}

projectSelect.addEventListener("change", handleProjectChange);
newProjectButton.addEventListener("click", createProject);
addTaskButton.addEventListener("click", addTask);
addMemberForm.addEventListener("submit", handleAddMember);

taskInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") addTask();
});

searchInput.addEventListener("input", renderBoard);

filterButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    currentFilter = button.dataset.filter;
    renderBoard();
  });
});

refreshActivityButton.addEventListener("click", loadActivity);

logoutButton.addEventListener("click", async function () {
  logoutButton.disabled = true;

  try {
    await apiRequest("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.error("Sign out request failed:", error);
  } finally {
    logoutButton.disabled = false;
    showLoginScreen();
  }
});

async function startTaskFlow() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });

    if (response.ok) {
      const result = await response.json();
      showApp(result.user);
      return;
    }

    authScreen.hidden = false;
    appScreen.hidden = true;
  } catch (error) {
    authScreen.hidden = false;
    appScreen.hidden = true;
    showAuthMessage(
      "Cannot reach the server. Start TaskFlow with 'node server.js' and refresh.",
      "error"
    );
  }
}

setAuthMode("login");
startTaskFlow();
