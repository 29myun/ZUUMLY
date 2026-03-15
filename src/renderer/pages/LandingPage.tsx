import React from "react";

interface LandingPageProps {
  onGetStarted: () => void;
  onLogin: () => void;
  onSignup: () => void;
  dark: boolean;
  onToggleTheme: () => void;
}

export default function LandingPage({ onGetStarted, onLogin, onSignup, dark, onToggleTheme }: LandingPageProps) {
  return (
    <div className="landing">
      <header className="landing-topbar">
        <div className="topbar-left">
          <h1 className="logo">ZUUMLY</h1>
          <span className="badge">BCIT Hackathon 2026</span>
        </div>
        <div className="topbar-right">
          <button className="ghost small" onClick={onLogin}>Login</button>
          <button className="primary small" onClick={onSignup}>Sign Up</button>
          <button className="theme-toggle" onClick={onToggleTheme} title={dark ? "Switch to light mode" : "Switch to dark mode"}>
            {dark ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      <section className="landing-hero">
        <div className="hero-glow" />
        <h2 className="hero-title">
          Your AI-Powered<br />
          <span className="hero-accent">Screen Assistant</span>
        </h2>
        <p className="hero-subtitle">
          Share your screen, capture snapshots, and get instant AI insights — all in one place.
        </p>
        <button className="hero-cta primary" onClick={onGetStarted}>
          Get Started as Guest
        </button>
      </section>

      <section className="landing-features">
        <div className="feature-card">
          <h3>Live Screen Capture</h3>
          <p>Share any window or your entire screen. Select specific regions for focused analysis.</p>
        </div>
        <div className="feature-card">
          <h3>AI Chat Assistant</h3>
          <p>Ask questions about what's on your screen and get context-aware responses.</p>
        </div>
        <div className="feature-card">
          <h3>Smart Snapshots</h3>
          <p>Capture and annotate screenshots. Share them with the AI for detailed visual analysis and guidance.</p>
        </div>
      </section>

      <footer className="landing-footer">
        <p>Built for BCIT Hackathon 2026</p>
      </footer>
    </div>
  );
}
