import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Difficulty = "easy" | "medium" | "hard";
type Duration = 15 | 30 | 60 | 120;
type User = { id: string; name: string; email: string; createdAt: string };
type AuthMode = "login" | "signup";
type Result = {
  id: string; date: string; wpm: number; rawWpm: number; accuracy: number;
  correct: number; incorrect: number; total: number; duration: number;
  difficulty: Difficulty; consistency: number;
};

const PROMPTS: Record<Difficulty, string[]> = {
  easy: [
    "Small steps every day can lead to impressive results.",
    "Practice makes typing faster, smoother, and more natural.",
    "The sun was warm and the morning air was calm.",
    "Good habits grow when you repeat them with patience.",
    "Learning to type quickly takes focus and regular practice.",
    "A clear mind and steady hands make typing easier."
  ],
  medium: [
    "Technology has changed the way people communicate, work, and learn.",
    "The quickest route is not always the simplest, so think before you act.",
    "Consistent practice builds confidence because every small improvement matters.",
    "A reliable workflow saves time and helps you concentrate on important tasks.",
    "Great results usually come from patient effort repeated over a long period."
  ],
  hard: [
    "Modern software rewards precision: punctuation, numbers, symbols, and capitalization all matter.",
    "When deadlines are tight, careful execution prevents small mistakes from becoming expensive problems.",
    "A resilient system should handle unexpected input, rapid changes, and incomplete information gracefully.",
    "Designers and developers collaborate best when requirements are explicit, measurable, and easy to verify.",
    "Efficient communication combines concise language with enough context to make every decision understandable."
  ]
};

const STORAGE_KEY = "typesprint-history-v1";
const SETTINGS_KEY = "typesprint-settings-v1";

function randomPrompt(difficulty: Difficulty) {
  const list = PROMPTS[difficulty];
  return list[Math.floor(Math.random() * list.length)];
}

function loadHistory(): Result[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: "include", headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data as T;
}

function App() {
  const [duration, setDuration] = useState<Duration>(60);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [prompt, setPrompt] = useState(() => randomPrompt("medium"));
  const [input, setInput] = useState("");
  const [timeLeft, setTimeLeft] = useState<number>(60);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [history, setHistory] = useState<Result[]>(loadHistory);
  const [currentResult, setCurrentResult] = useState<Result | null>(null);
  const [tab, setTab] = useState<"test" | "history" | "stats">("test");
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authOpen, setAuthOpen] = useState(false);
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const inputRef = useRef<HTMLDivElement>(null);
  const inputValueRef = useRef("");
  const finishedRef = useRef(false);

  useEffect(() => {
    api<{ user: User | null }>("/api/me").then(async ({ user: currentUser }) => {
      setUser(currentUser);
      if (currentUser) {
        try {
          const data = await api<{ results: Result[] }>("/api/results");
          setHistory(data.results);
        } catch { /* keep local cache if the database request fails */ }
      }
    }).catch(() => { /* backend can be started separately for offline/local mode */ });
  }, []);

  const currentSeconds = startedAt ? Math.max(0.001, (Date.now() - startedAt) / 1000) : elapsed || 0;
  const typed = input.length;
  const correct = useMemo(() => [...input].reduce((n, ch, i) => n + (ch === prompt[i] ? 1 : 0), 0), [input, prompt]);
  const incorrect = Math.max(0, typed - correct);
  const liveMinutes = Math.max(currentSeconds / 60, 1 / 60);
  const liveWpm = Math.round((typed / 5) / liveMinutes);
  const liveAccuracy = typed ? Math.round((correct / typed) * 100) : 100;

  const best = history.length ? Math.max(...history.map(r => r.wpm)) : 0;
  const avg = history.length ? Math.round(history.reduce((s, r) => s + r.wpm, 0) / history.length) : 0;

  const saveResultToServer = async (result: Result) => {
    if (!user) return;
    try {
      await api("/api/results", { method: "POST", body: JSON.stringify(result) });
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "Could not save this result to the database.");
    }
  };

  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const data = await api<{ user: User }>(authMode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify(authMode === "signup"
          ? { name: authName, email: authEmail, password: authPassword }
          : { email: authEmail, password: authPassword })
      });
      setUser(data.user);
      setAuthOpen(false);
      setAuthPassword("");
      setAccountMessage(`Signed in as ${data.user.name}.`);
      const results = await api<{ results: Result[] }>("/api/results");
      setHistory(results.results);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch { /* ignore logout network errors */ }
    setUser(null);
    setAccountMessage("Signed out. New results will stay on this browser until you sign in again.");
    setHistory(loadHistory());
  };

  const finish = (finalElapsed?: number, finalInput = inputValueRef.current) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const finalTyped = finalInput.length;
    const finalCorrect = [...finalInput].reduce((n, ch, i) => n + (ch === prompt[i] ? 1 : 0), 0);
    const finalIncorrect = Math.max(0, finalTyped - finalCorrect);
    const secs = finalElapsed ?? Math.min(duration, Math.max(0.001, (Date.now() - (startedAt || Date.now())) / 1000));
    const minutes = Math.max(secs / 60, 1 / 60);
    const wpm = Math.round((finalTyped / 5) / minutes);
    const rawWpm = Math.round((finalTyped / 5) / minutes);
    const accuracy = finalTyped ? Math.round((finalCorrect / finalTyped) * 100) : 100;
    const consistency = Math.max(0, Math.min(100, Math.round(100 - Math.abs(wpm - (history.length ? avg : wpm)) * 1.5)));
    const result: Result = {
      id: crypto.randomUUID(), date: new Date().toISOString(), wpm, rawWpm, accuracy,
      correct: finalCorrect, incorrect: finalIncorrect, total: finalTyped, duration: Math.round(secs),
      difficulty, consistency
    };
    setCurrentResult(result);
    setHistory(prev => {
      const next = [result, ...prev].slice(0, 100);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    void saveResultToServer(result);
    setElapsed(secs);
    setStarted(false);
    setFinished(true);
  };

  useEffect(() => {
    if (!started) return;
    const timer = window.setInterval(() => {
      const secs = (Date.now() - (startedAt || Date.now())) / 1000;
      const left = Math.max(0, Math.ceil(duration - secs));
      setTimeLeft(left as Duration);
      if (left <= 0) finish(duration, inputValueRef.current);
    }, 100);
    return () => clearInterval(timer);
  }, [started, startedAt, duration]);

  useEffect(() => {
    const settings = { duration, difficulty };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [duration, difficulty]);

  const restart = (newDuration = duration, newDifficulty = difficulty) => {
    setDuration(newDuration as Duration);
    setDifficulty(newDifficulty);
    setPrompt(randomPrompt(newDifficulty));
    setInput("");
    inputValueRef.current = "";
    finishedRef.current = false;
    setTimeLeft(newDuration as Duration);
    setStarted(false);
    setFinished(false);
    setStartedAt(null);
    setElapsed(0);
    setCurrentResult(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onType = (value: string) => {
    if (finished) return;
    if (!started && value.length > 0) {
      setStartedAt(Date.now());
      setStarted(true);
    }
    inputValueRef.current = value;
    setInput(value);
    if (value.length >= prompt.length) {
      const start = startedAt ?? Date.now();
      const secs = Math.max(0.001, (Date.now() - start) / 1000);
      setTimeout(() => finish(secs, value), 0);
    }
  };

  const handleTypingKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (finished || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "Backspace") {
      e.preventDefault();
      onType(inputValueRef.current.slice(0, -1));
      return;
    }

    if (e.key.length === 1) {
      e.preventDefault();
      onType(inputValueRef.current + e.key);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (finished) return;
    const pasted = e.clipboardData.getData("text").replace(/\r?\n/g, " ");
    if (pasted) onType(inputValueRef.current + pasted);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); restart(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); restart(); }
      if (e.key === "Tab" && e.shiftKey === false) { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [duration, difficulty]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><div className="brandMark">TS</div><div><b>TypeSprint</b><span>typing speed lab</span></div></div>
        <nav>
          <button className={tab === "test" ? "nav active" : "nav"} onClick={() => setTab("test")}>Test</button>
          <button className={tab === "history" ? "nav active" : "nav"} onClick={() => setTab("history")}>History</button>
          <button className={tab === "stats" ? "nav active" : "nav"} onClick={() => setTab("stats")}>Statistics</button>
        </nav>
        <div className="accountArea">
          {user ? <><span className="userBadge">{user.name}</span><button className="accountButton" onClick={logout}>Log out</button></> : <button className="accountButton primarySmall" onClick={() => { setAuthMode("signup"); setAuthError(""); setAuthOpen(true); }}>Sign up</button>}
        </div>
      </header>

      <main>
        {accountMessage && <div className="accountMessage" role="status">{accountMessage}<button onClick={() => setAccountMessage("")}>×</button></div>}
        {tab === "test" && (
          <>
            <section className="hero">
              <div>
                <div className="eyebrow">Typing speed test</div>
                <h1>Type fast.<br/><em>Stay accurate.</em></h1>
                <p>Measure your WPM, accuracy, consistency and errors in a clean, distraction-free test.</p>
              </div>
              <div className="heroBest"><span>PERSONAL BEST</span><strong>{best || "—"}</strong><small>WPM</small></div>
            </section>

            <section className="controls card">
              <div><label>TEST LENGTH</label><div className="seg">{([15,30,60,120] as Duration[]).map(d => <button key={d} className={duration === d ? "selected":""} onClick={() => restart(d)}>{d}s</button>)}</div></div>
              <div><label>DIFFICULTY</label><div className="seg">{(["easy","medium","hard"] as Difficulty[]).map(d => <button key={d} className={difficulty === d ? "selected":""} onClick={() => restart(duration,d)}>{d}</button>)}</div></div>
            </section>

            <section className="liveStats">
              <div><span>TIME</span><strong>{started ? timeLeft : finished ? Math.round(elapsed) : duration}s</strong></div>
              <div><span>WPM</span><strong>{finished ? (history[0]?.wpm ?? 0) : liveWpm}</strong></div>
              <div><span>ACCURACY</span><strong>{finished ? `${history[0]?.accuracy ?? 100}%` : `${liveAccuracy}%`}</strong></div>
              <div><span>ERRORS</span><strong>{finished ? (history[0]?.incorrect ?? 0) : incorrect}</strong></div>
            </section>

            <section className={"typing card " + (finished ? "finished" : "")} onClick={() => inputRef.current?.focus()}>
              {!finished ? (
                <>
                  <div className="prompt" aria-label="Typing prompt">
                    {prompt.split("").map((ch, i) => {
                      const typedCh = input[i];
                      const cls = typedCh == null ? (i === input.length ? "current" : "") : typedCh === ch ? "correct" : "wrong";
                      return <span className={cls} key={i}>{ch === " " ? "\u00A0" : ch}</span>;
                    })}
                  </div>
                  <div
                    ref={inputRef}
                    className="typingCapture"
                    tabIndex={0}
                    role="textbox"
                    aria-label="Type the prompt"
                    aria-multiline="false"
                    onKeyDown={handleTypingKeyDown}
                    onPaste={handlePaste}
                    onMouseDown={() => inputRef.current?.focus()}
                  />
                  <div className="hint"><span>ESC to restart</span><span>⌘/CTRL + ENTER for new test</span></div>
                </>
              ) : (
                <div className="result">
                  <div className="eyebrow">Test complete</div>
                  <div className="bigResult">{currentResult?.wpm ?? 0}<small>WPM</small></div>
                  <div className="resultGrid">
                    <div><span>Accuracy</span><b>{currentResult?.accuracy}%</b></div>
                    <div><span>Correct</span><b>{currentResult?.correct}</b></div>
                    <div><span>Errors</span><b>{currentResult?.incorrect}</b></div>
                    <div><span>Time</span><b>{currentResult?.duration}s</b></div>
                  </div>
                  <button className="primary" onClick={() => restart()}>Try again <span>↗</span></button>
                </div>
              )}
            </section>

            <section className="bottomCards">
              <div className="card mini"><span>AVERAGE WPM</span><strong>{avg || "—"}</strong><small>Across {history.length} tests</small></div>
              <div className="card mini"><span>TESTS COMPLETED</span><strong>{history.length}</strong><small>Keep building your streak</small></div>
              <div className="card mini"><span>BEST ACCURACY</span><strong>{history.length ? Math.max(...history.map(x => x.accuracy)) : "—"}{history.length ? "%" : ""}</strong><small>Precision matters</small></div>
            </section>
          </>
        )}

        {tab === "history" && (
          <section className="pageSection">
            <div className="sectionHead"><div><div className="eyebrow">Your progress</div><h2>Test history</h2></div><button className="secondary" onClick={async () => {
              localStorage.removeItem(STORAGE_KEY);
              setHistory([]);
              if (user) { try { await api("/api/results", { method: "DELETE" }); } catch (error) { setAccountMessage(error instanceof Error ? error.message : "Could not clear database history."); } }
            }}>Clear history</button></div>
            {history.length === 0 ? <div className="empty card">No tests yet. Complete your first typing test to see it here.</div> :
              <div className="historyList">{history.map(r => <div className="historyRow card" key={r.id}><div><b>{r.wpm} WPM</b><span>{formatDate(r.date)} · {r.duration}s · {r.difficulty}</span></div><div><strong>{r.accuracy}%</strong><span>accuracy</span></div><div><strong>{r.incorrect}</strong><span>errors</span></div></div>)}</div>}
          </section>
        )}

        {tab === "stats" && (
          <section className="pageSection">
            <div className="eyebrow">Performance</div><h2>Your statistics</h2>
            <div className="statGrid">
              <div className="card stat"><span>BEST WPM</span><strong>{best || "—"}</strong><small>Highest recorded result</small></div>
              <div className="card stat"><span>AVERAGE WPM</span><strong>{avg || "—"}</strong><small>Across all completed tests</small></div>
              <div className="card stat"><span>BEST ACCURACY</span><strong>{history.length ? Math.max(...history.map(r => r.accuracy)) : "—"}{history.length ? "%" : ""}</strong><small>Highest accuracy</small></div>
              <div className="card stat"><span>TOTAL TESTS</span><strong>{history.length}</strong><small>Saved locally in this browser</small></div>
            </div>
            <div className="card chart"><h3>Recent WPM</h3>{history.length ? <div className="bars">{history.slice(0,12).reverse().map((r,i) => <div className="barWrap" key={r.id}><div className="bar" style={{height: `${Math.max(8, Math.min(100, r.wpm / Math.max(best,1) * 100))}%`}} title={`${r.wpm} WPM`}></div><small>{r.wpm}</small></div>)}</div> : <div className="empty">Complete a test to generate your performance chart.</div>}</div>
          </section>
        )}
      </main>
      {authOpen && (
        <div className="modalBackdrop" onMouseDown={() => setAuthOpen(false)}>
          <div className="authModal card" onMouseDown={e => e.stopPropagation()}>
            <button className="modalClose" onClick={() => setAuthOpen(false)} aria-label="Close">×</button>
            <div className="eyebrow">TypeSprint account</div>
            <h2>{authMode === "signup" ? "Create your account" : "Welcome back"}</h2>
            <p className="authIntro">Save your typing history to the local SQLite database and access it whenever you sign in.</p>
            <form onSubmit={submitAuth} className="authForm">
              {authMode === "signup" && <label><span>Name</span><input value={authName} onChange={e => setAuthName(e.target.value)} autoComplete="name" required minLength={2} maxLength={60} /></label>}
              <label><span>Email</span><input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} autoComplete="email" required /></label>
              <label><span>Password</span><input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} autoComplete={authMode === "signup" ? "new-password" : "current-password"} minLength={8} required /></label>
              {authError && <div className="authError">{authError}</div>}
              <button className="primary authSubmit" disabled={authBusy}>{authBusy ? "Please wait…" : authMode === "signup" ? "Create account" : "Sign in"}</button>
            </form>
            <button className="switchAuth" onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setAuthError(""); }}>
              {authMode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
            </button>
            <small className="dbNote">Passwords are stored as secure hashes. Your SQLite file is <b>data/typesprint.db</b>.</small>
          </div>
        </div>
      )}

      <footer>{user ? `TypeSprint · Signed in as ${user.email} · Results sync to SQLite` : "TypeSprint · Guest results stay in this browser · Sign up to sync to SQLite"}</footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
