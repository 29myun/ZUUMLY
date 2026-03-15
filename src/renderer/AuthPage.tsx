import React, { useState } from "react";

interface AuthPageProps {
  mode: "login" | "signup";
  onSwitchMode: () => void;
  onLogin: (email: string, password: string) => Promise<void>;
  onSignup: (name: string, email: string, password: string) => Promise<void>;
  onBack: () => void;
  dark: boolean;
  onToggleTheme: () => void;
}

export default function AuthPage({
  mode,
  onSwitchMode,
  onLogin,
  onSignup,
  onBack,
  dark,
  onToggleTheme,
}: AuthPageProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }

    if (mode === "signup") {
      if (!name.trim()) {
        setError("Name is required.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
    }

    setLoading(true);
    try {
      if (mode === "signup") {
        await onSignup(name.trim(), email.trim(), password);
      } else {
        await onLogin(email.trim(), password);
      }
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const resetFields = () => {
    setName("");
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setError(null);
  };

  const handleSwitch = () => {
    resetFields();
    onSwitchMode();
  };

  return (
    <div className="landing">
      <header className="landing-topbar">
        <div className="topbar-left">
          <button className="ghost small" onClick={onBack}>
            ← Back
          </button>
          <h1 className="logo">ZUUMLY</h1>
        </div>
        <div className="topbar-right">
          <button
            className="theme-toggle"
            onClick={onToggleTheme}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {dark ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      <div className="auth-container">
        <div className="auth-card">
          <h2 className="auth-title">
            {mode === "login" ? "Welcome back" : "Create an account"}
          </h2>
          <p className="auth-subtitle">
            {mode === "login"
              ? "Sign in to continue to ZUUMLY"
              : "Sign up to get started with ZUUMLY"}
          </p>

          <form className="auth-form" onSubmit={handleSubmit}>
            {mode === "signup" && (
              <label className="auth-field">
                <span>Name</span>
                <input
                  type="text"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </label>
            )}

            <label className="auth-field">
              <span>Email</span>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>

            <label className="auth-field">
              <span>Password</span>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </label>

            {mode === "signup" && (
              <label className="auth-field">
                <span>Confirm password</span>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}

            {error && <p className="auth-error">{error}</p>}

            <button className="primary auth-submit" type="submit" disabled={loading}>
              {loading
                ? "Please wait..."
                : mode === "login"
                  ? "Sign In"
                  : "Create Account"}
            </button>
          </form>

          <p className="auth-switch">
            {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
            <button className="auth-switch-btn" type="button" onClick={handleSwitch}>
              {mode === "login" ? "Sign up" : "Sign in"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
