// Configuration
const WORKER_URL = "https://gh-dir-diff-oauth.mullein-rapids-4s.workers.dev";

// Token management
let accessToken = localStorage.getItem("github_token");

// Handle OAuth callback (token in URL fragment)
function handleOAuthCallback() {
  const hash = window.location.hash;
  if (hash.includes("access_token=")) {
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get("access_token");
    if (token) {
      localStorage.setItem("github_token", token);
      accessToken = token;
      // Clear the hash from URL
      history.replaceState(null, "", window.location.pathname);
    }
  }
}

// Update UI based on auth state
async function updateAuthUI() {
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const userInfo = document.getElementById("user-info");

  if (accessToken) {
    loginBtn.style.display = "none";
    logoutBtn.style.display = "inline-block";

    // Fetch user info
    try {
      const response = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        const user = await response.json();
        userInfo.textContent = `Logged in as ${user.login}`;
      } else {
        // Token might be invalid
        logout();
      }
    } catch (e) {
      console.error("Failed to fetch user info", e);
    }
  } else {
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
    userInfo.textContent = "";
  }
}

function logout() {
  localStorage.removeItem("github_token");
  accessToken = null;
  updateAuthUI();
}

// Improved glob matching function
function matchGlob(pattern, path) {
  if (!pattern) return true;

  // Escape special regex characters except glob patterns
  const escapeRegex = (str) => str.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Split pattern into segments to handle ** properly
  const segments = pattern.split('/');
  let regexPattern = '';

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment === '**') {
      // ** matches zero or more directories
      if (i === segments.length - 1) {
        // ** at the end matches everything
        regexPattern += '.*';
      } else {
        // ** in the middle matches zero or more path segments
        regexPattern += '(?:.*/)?';
      }
    } else {
      // Process * and ? in the segment
      let segmentPattern = '';
      for (let j = 0; j < segment.length; j++) {
        const char = segment[j];
        if (char === '*') {
          segmentPattern += '[^/]*'; // * matches anything except /
        } else if (char === '?') {
          segmentPattern += '[^/]'; // ? matches single char except /
        } else {
          segmentPattern += escapeRegex(char);
        }
      }
      regexPattern += segmentPattern;

      // Add / between segments (except at the end)
      if (i < segments.length - 1) {
        regexPattern += '/';
      }
    }
  }

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}

// Load diff from GitHub API
async function loadDiff(event) {
  event.preventDefault();

  const repo = document.getElementById("repo").value.trim();
  const base = document.getElementById("base").value.trim();
  const head = document.getElementById("head").value.trim();
  const pathFilter = document.getElementById("path-filter").value.trim();

  const loading = document.getElementById("loading");
  const error = document.getElementById("error");
  const stats = document.getElementById("diff-stats");
  const container = document.getElementById("diff-container");

  loading.style.display = "block";
  error.textContent = "";
  stats.innerHTML = "";
  container.innerHTML = "";

  try {
    const headers = { Accept: "application/vnd.github.v3.diff" };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    // First, get the compare data as JSON for file list
    const jsonResponse = await fetch(
      `https://api.github.com/repos/${repo}/compare/${base}...${head}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        },
      }
    );

    if (!jsonResponse.ok) {
      // Handle rate limiting with helpful message
      if (jsonResponse.status === 403) {
        const rateLimitRemaining = jsonResponse.headers.get("X-RateLimit-Remaining");
        const rateLimitReset = jsonResponse.headers.get("X-RateLimit-Reset");

        if (rateLimitRemaining === "0" && rateLimitReset) {
          const resetDate = new Date(parseInt(rateLimitReset) * 1000);
          const minutesUntilReset = Math.ceil((resetDate - new Date()) / 60000);

          throw new Error(
            accessToken
              ? `Rate limit exceeded. Resets in ${minutesUntilReset} minutes.`
              : `Rate limit exceeded (60 requests/hour for unauthenticated requests). Please login for higher limits (5,000/hour), or wait ${minutesUntilReset} minutes.`
          );
        }
      }

      const errData = await jsonResponse.json().catch(() => ({}));
      throw new Error(errData.message || `HTTP ${jsonResponse.status}`);
    }

    const compareData = await jsonResponse.json();

    // Filter files by path
    let files = compareData.files || [];
    if (pathFilter) {
      files = files.filter((f) => matchGlob(pathFilter, f.filename));
    }

    if (files.length === 0) {
      stats.innerHTML = "<p>No files match the filter.</p>";
      loading.style.display = "none";
      return;
    }

    // Build unified diff from patches, handling edge cases
    let unifiedDiff = "";
    for (const file of files) {
      // Skip binary files
      if (file.patch === undefined && file.status !== "removed" && file.status !== "added") {
        // Binary file or file without changes
        continue;
      }

      const oldFilename = file.previous_filename || file.filename;
      const newFilename = file.filename;

      // Handle different file statuses
      if (file.status === "removed") {
        unifiedDiff += `diff --git a/${oldFilename} b/${oldFilename}\n`;
        unifiedDiff += `deleted file mode ${file.previous_mode || "100644"}\n`;
        unifiedDiff += `--- a/${oldFilename}\n`;
        unifiedDiff += `+++ /dev/null\n`;
      } else if (file.status === "added") {
        unifiedDiff += `diff --git a/${newFilename} b/${newFilename}\n`;
        unifiedDiff += `new file mode ${file.mode || "100644"}\n`;
        unifiedDiff += `--- /dev/null\n`;
        unifiedDiff += `+++ b/${newFilename}\n`;
      } else if (file.status === "renamed") {
        unifiedDiff += `diff --git a/${oldFilename} b/${newFilename}\n`;
        unifiedDiff += `rename from ${oldFilename}\n`;
        unifiedDiff += `rename to ${newFilename}\n`;
        if (file.patch) {
          // File was renamed and modified
          unifiedDiff += `--- a/${oldFilename}\n`;
          unifiedDiff += `+++ b/${newFilename}\n`;
        }
      } else {
        // Modified file
        unifiedDiff += `diff --git a/${file.filename} b/${file.filename}\n`;
        unifiedDiff += `--- a/${file.filename}\n`;
        unifiedDiff += `+++ b/${file.filename}\n`;
      }

      // Add patch content if available
      if (file.patch) {
        unifiedDiff += file.patch + "\n";
      }
    }

    // Update URL for sharing
    updateURL();

    // Show stats with share button
    const additions = files.reduce((sum, f) => sum + (f.additions || 0), 0);
    const deletions = files.reduce((sum, f) => sum + (f.deletions || 0), 0);
    stats.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong>${files.length}</strong> files changed,
          <strong style="color:#2da44e">+${additions}</strong> additions,
          <strong style="color:#cf222e">-${deletions}</strong> deletions
          ${pathFilter ? `(filtered by: <code>${pathFilter}</code>)` : ""}
        </div>
        <button id="share-btn" onclick="copyShareLink()" style="background:#0969da; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:14px;">
          📋 Copy Link
        </button>
      </div>
    `;

    // Render diff
    if (unifiedDiff) {
      const diff2htmlUi = new Diff2HtmlUI(container, unifiedDiff, {
        drawFileList: true,
        matching: "lines",
        outputFormat: "side-by-side",
      });
      diff2htmlUi.draw();
      diff2htmlUi.highlightCode();
    }
  } catch (e) {
    error.textContent = `Error: ${e.message}`;
  } finally {
    loading.style.display = "none";
  }
}

// Update URL with current form state (for sharing)
function updateURL() {
  const repo = document.getElementById("repo").value.trim();
  const base = document.getElementById("base").value.trim();
  const head = document.getElementById("head").value.trim();
  const filter = document.getElementById("path-filter").value.trim();

  if (repo && base && head) {
    let url = `/gh-dir-diff/${repo}/${base}..${head}`;
    if (filter) {
      url += `?filter=${encodeURIComponent(filter)}`;
    }
    history.replaceState(null, "", url);
  }
}

// Copy shareable link to clipboard
function copyShareLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById("share-btn");
    const originalText = btn.textContent;
    btn.textContent = "✓ Copied!";
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  }).catch(err => {
    console.error("Failed to copy link:", err);
    alert("Failed to copy link. Please copy from the address bar.");
  });
}

// Parse path-based URL: /gh-dir-diff/owner/repo/base..head?filter=glob
function loadFromURL() {
  const pathname = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  // Check if we have a path-based URL
  if (pathname.startsWith('/gh-dir-diff/') && pathname.length > '/gh-dir-diff/'.length) {
    // Remove /gh-dir-diff/ prefix
    let path = pathname.slice('/gh-dir-diff/'.length);

    // Remove trailing slash if present
    if (path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    // Split by .. to separate base and head
    const parts = path.split('..');

    if (parts.length === 2) {
      // parts[0] contains: owner/repo/base (with possible slashes in base)
      // parts[1] contains: head (with possible slashes)

      const segments = parts[0].split('/');

      if (segments.length >= 2) {
        // First two segments are always owner/repo
        const repo = `${segments[0]}/${segments[1]}`;
        // Everything after is the base ref
        const base = segments.slice(2).join('/');
        const head = parts[1];

        console.log('Parsed URL:', { repo, base, head, filter: params.get("filter") });

        // Populate form
        document.getElementById("repo").value = repo;
        document.getElementById("base").value = base;
        document.getElementById("head").value = head;
        document.getElementById("path-filter").value = params.get("filter") || "";

        // Auto-load diff
        setTimeout(() => {
          const form = document.getElementById("diff-form");
          console.log('Form validity:', form.checkValidity());
          if (form.checkValidity()) {
            const event = new Event("submit", { bubbles: true, cancelable: true });
            form.dispatchEvent(event);
          } else {
            console.error('Form is not valid:', {
              repo: document.getElementById("repo").validity,
              base: document.getElementById("base").validity,
              head: document.getElementById("head").validity
            });
          }
        }, 100);

        return;
      }
    }
  }

  // Fallback to query params for backwards compatibility
  if (params.get("repo")) {
    document.getElementById("repo").value = params.get("repo") || "";
    document.getElementById("base").value = params.get("base") || "";
    document.getElementById("head").value = params.get("head") || "";
    document.getElementById("path-filter").value = params.get("filter") || "";

    // Auto-load diff when URL params are present
    setTimeout(() => {
      const form = document.getElementById("diff-form");
      if (form.checkValidity()) {
        const event = new Event("submit", { bubbles: true, cancelable: true });
        form.dispatchEvent(event);
      }
    }, 100);
  }
}

// Initialize
handleOAuthCallback();
updateAuthUI();
loadFromURL();

// Update login button URL
document.getElementById("login-btn").href = `${WORKER_URL}/login`;
