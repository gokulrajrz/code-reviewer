// — Dashboard HTML Templates —
import { WORKER_VERSION } from '../config/constants';

export function loginHtml(error?: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CODE-REVIEWER // SYSTEM ACCESS</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Archivo+Black&display=swap" rel="stylesheet">
    <style>
        :root {
            --void: #0a0a0f;
            --void-light: #12121a;
            --void-lighter: #1a1a25;
            --cyan: #00f0ff;
            --cyan-dim: #00a8b3;
            --amber: #ffb800;
            --red: #ff3366;
            --green: #00ff88;
            --text-primary: #e0e0e0;
            --text-dim: #6b6b7b;
            --grid-color: rgba(0, 240, 255, 0.03);
        }
        
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box;
        }
        
        @keyframes scanline {
            0% { transform: translateY(-100%); }
            100% { transform: translateY(100vh); }
        }
        
        @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
        }
        
        @keyframes pulse-glow {
            0%, 100% { box-shadow: 0 0 20px rgba(0, 240, 255, 0.3); }
            50% { box-shadow: 0 0 40px rgba(0, 240, 255, 0.6); }
        }
        
        @keyframes grid-move {
            0% { background-position: 0 0; }
            100% { background-position: 50px 50px; }
        }
        
        @keyframes glitch {
            0%, 90%, 100% { transform: translate(0); }
            92% { transform: translate(-2px, 1px); }
            94% { transform: translate(2px, -1px); }
            96% { transform: translate(-1px, 2px); }
        }
        
        body {
            font-family: 'JetBrains Mono', monospace;
            background: var(--void);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
            color: var(--text-primary);
        }
        
        /* Animated Grid Background */
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-image: 
                linear-gradient(var(--grid-color) 1px, transparent 1px),
                linear-gradient(90deg, var(--grid-color) 1px, transparent 1px);
            background-size: 50px 50px;
            animation: grid-move 20s linear infinite;
            pointer-events: none;
            z-index: 1;
        }
        
        /* CRT Scanline Effect */
        body::after {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(
                transparent 50%,
                rgba(0, 0, 0, 0.25) 50%
            );
            background-size: 100% 4px;
            pointer-events: none;
            z-index: 2;
        }
        
        .scanline-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--cyan), transparent);
            animation: scanline 4s linear infinite;
            opacity: 0.5;
            z-index: 3;
        }
        
        .login-container {
            position: relative;
            z-index: 10;
            width: 100%;
            max-width: 480px;
            padding: 3rem;
            margin: 1rem;
        }
        
        .terminal-frame {
            background: var(--void-light);
            border: 1px solid var(--cyan-dim);
            border-radius: 4px;
            padding: 2.5rem;
            position: relative;
            box-shadow: 
                0 0 0 1px var(--void),
                0 0 60px rgba(0, 240, 255, 0.1),
                inset 0 0 60px rgba(0, 240, 255, 0.02);
            animation: pulse-glow 4s ease-in-out infinite;
        }
        
        /* Corner Accents */
        .terminal-frame::before,
        .terminal-frame::after {
            content: '';
            position: absolute;
            width: 20px;
            height: 20px;
            border: 2px solid var(--cyan);
        }
        
        .terminal-frame::before {
            top: -2px;
            left: -2px;
            border-right: none;
            border-bottom: none;
        }
        
        .terminal-frame::after {
            bottom: -2px;
            right: -2px;
            border-left: none;
            border-top: none;
        }
        
        .header-section {
            text-align: center;
            margin-bottom: 2.5rem;
            border-bottom: 1px solid var(--void-lighter);
            padding-bottom: 1.5rem;
        }
        
        .system-label {
            font-size: 0.7rem;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 0.3em;
            margin-bottom: 0.5rem;
        }
        
        .main-title {
            font-family: 'Archivo Black', sans-serif;
            font-size: 1.8rem;
            color: var(--cyan);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            text-shadow: 0 0 20px rgba(0, 240, 255, 0.5);
            margin-bottom: 0.5rem;
        }
        
        .status-line {
            font-size: 0.75rem;
            color: var(--amber);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }
        
        .status-indicator {
            width: 8px;
            height: 8px;
            background: var(--amber);
            border-radius: 50%;
            animation: blink 1s step-end infinite;
            box-shadow: 0 0 10px var(--amber);
        }
        
        .error-message {
            background: rgba(255, 51, 102, 0.1);
            border: 1px solid var(--red);
            border-left: 4px solid var(--red);
            padding: 1rem;
            margin-bottom: 1.5rem;
            font-size: 0.85rem;
            color: var(--red);
            animation: glitch 0.3s ease-in-out;
        }
        
        .error-message::before {
            content: '[ERROR] ';
            font-weight: bold;
        }
        
        .input-group {
            margin-bottom: 1.5rem;
        }
        
        .input-label {
            display: block;
            font-size: 0.7rem;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 0.15em;
            margin-bottom: 0.5rem;
        }
        
        .input-wrapper {
            position: relative;
        }
        
        .input-wrapper::before {
            content: '>';
            position: absolute;
            left: 1rem;
            top: 50%;
            transform: translateY(-50%);
            color: var(--cyan);
            font-weight: bold;
        }
        
        input[type="text"],
        input[type="password"] {
            width: 100%;
            padding: 1rem 1rem 1rem 2.5rem;
            background: var(--void);
            border: 1px solid var(--void-lighter);
            color: var(--cyan);
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.95rem;
            border-radius: 2px;
            transition: all 0.3s ease;
        }
        
        input[type="text"]:focus,
        input[type="password"]:focus {
            outline: none;
            border-color: var(--cyan);
            box-shadow: 0 0 20px rgba(0, 240, 255, 0.2);
        }
        
        input::placeholder {
            color: var(--text-dim);
        }
        
        .submit-btn {
            width: 100%;
            padding: 1rem;
            background: transparent;
            border: 2px solid var(--cyan);
            color: var(--cyan);
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.9rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.2em;
            cursor: pointer;
            border-radius: 2px;
            position: relative;
            overflow: hidden;
            transition: all 0.3s ease;
        }
        
        .submit-btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(0, 240, 255, 0.2), transparent);
            transition: left 0.5s ease;
        }
        
        .submit-btn:hover {
            background: rgba(0, 240, 255, 0.1);
            box-shadow: 0 0 30px rgba(0, 240, 255, 0.4);
        }
        
        .submit-btn:hover::before {
            left: 100%;
        }
        
        .footer-section {
            margin-top: 2rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--void-lighter);
            text-align: center;
        }
        
        .creds-info {
            font-size: 0.7rem;
            color: var(--text-dim);
        }
        
        .creds-info strong {
            color: var(--cyan);
            font-weight: normal;
        }
        
        .version-tag {
            position: absolute;
            bottom: -30px;
            right: 0;
            font-size: 0.65rem;
            color: var(--text-dim);
        }
        
        /* Decorative Elements */
        .deco-lines {
            position: absolute;
            top: 20px;
            left: 20px;
            right: 20px;
            display: flex;
            justify-content: space-between;
            pointer-events: none;
        }
        
        .deco-line {
            height: 1px;
            background: linear-gradient(90deg, var(--cyan), transparent);
            width: 100px;
        }
        
        .deco-line:last-child {
            background: linear-gradient(90deg, transparent, var(--cyan));
        }
        
        @media (max-width: 600px) {
            .login-container {
                padding: 1.5rem;
            }
            
            .terminal-frame {
                padding: 1.5rem;
            }
            
            .main-title {
                font-size: 1.4rem;
            }
        }
    </style>
</head>
<body>
    <div class="scanline-bar"></div>
    <div class="login-container">
        <div class="terminal-frame">
            <div class="deco-lines">
                <div class="deco-line"></div>
                <div class="deco-line"></div>
            </div>
            
            <div class="header-section">
                <div class="system-label">// SYSTEM ACCESS //</div>
                <h1 class="main-title">CODE-REVIEWER</h1>
                <div class="status-line">
                    <span class="status-indicator"></span>
                    <span>AWAITING CREDENTIALS</span>
                </div>
            </div>
            
            ${error ? `<div class="error-message">${escapeHtml(error)}</div>` : ''}
            
            <form method="POST" action="/dashboard/login">
                <div class="input-group">
                    <label class="input-label">Operator ID</label>
                    <div class="input-wrapper">
                        <input type="text" id="username" name="username" placeholder="ENTER_USERNAME" required autofocus autocomplete="off">
                    </div>
                </div>
                
                <div class="input-group">
                    <label class="input-label">Access Code</label>
                    <div class="input-wrapper">
                        <input type="password" id="password" name="password" placeholder="ENTER_ACCESS_CODE" required autocomplete="off">
                    </div>
                </div>
                
                <button type="submit" class="submit-btn">
                    [ AUTHENTICATE ]
                </button>
            </form>
            
            <div class="footer-section">
                <div class="creds-info">
                    CREDENTIALS: Set via <strong>DASHBOARD_USERNAME</strong> / <strong>DASHBOARD_PASSWORD</strong> environment secrets
                </div>
            </div>
            
            <div class="version-tag">v${WORKER_VERSION} // BUILD_2024</div>
        </div>
    </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    const div = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => div[m as keyof typeof div]);
}

export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Code Reviewer Usage Dashboard - Monitor LLM usage and costs">
    <title>CODE-REVIEWER // MISSION_CONTROL</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Archivo+Black&display=swap" rel="stylesheet">
    <style>
        :root {
            --void: #0a0a0f;
            --void-light: #12121a;
            --void-lighter: #1a1a25;
            --void-card: #0f0f16;
            --cyan: #00f0ff;
            --cyan-dim: #00a8b3;
            --cyan-glow: rgba(0, 240, 255, 0.3);
            --amber: #ffb800;
            --amber-glow: rgba(255, 184, 0, 0.3);
            --red: #ff3366;
            --red-glow: rgba(255, 51, 102, 0.3);
            --green: #00ff88;
            --green-glow: rgba(0, 255, 136, 0.3);
            --text-primary: #e0e0e0;
            --text-secondary: #a0a0b0;
            --text-dim: #6b6b7b;
            --border: rgba(0, 240, 255, 0.2);
            --grid-color: rgba(0, 240, 255, 0.03);
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        @keyframes scanline {
            0% { transform: translateY(-100%); }
            100% { transform: translateY(100vh); }
        }
        
        @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
        }
        
        @keyframes pulse-glow {
            0%, 100% { box-shadow: 0 0 20px var(--cyan-glow); }
            50% { box-shadow: 0 0 40px var(--cyan-glow), 0 0 60px var(--cyan-glow); }
        }
        
        @keyframes grid-move {
            0% { background-position: 0 0; }
            100% { background-position: 50px 50px; }
        }
        
        @keyframes data-stream {
            0% { background-position: 0 0; }
            100% { background-position: 0 20px; }
        }
        
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        
        @keyframes slideOut {
            to { transform: translateX(100%); opacity: 0; }
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        body {
            font-family: 'JetBrains Mono', monospace;
            background: var(--void);
            color: var(--text-primary);
            min-height: 100vh;
            line-height: 1.5;
            position: relative;
            overflow-x: hidden;
        }
        
        /* Animated Grid Background */
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-image: 
                linear-gradient(var(--grid-color) 1px, transparent 1px),
                linear-gradient(90deg, var(--grid-color) 1px, transparent 1px);
            background-size: 50px 50px;
            animation: grid-move 20s linear infinite;
            pointer-events: none;
            z-index: 1;
        }
        
        /* CRT Scanline Effect */
        body::after {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(transparent 50%, rgba(0, 0, 0, 0.25) 50%);
            background-size: 100% 4px;
            pointer-events: none;
            z-index: 2;
        }
        
        .scanline-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--cyan), transparent);
            animation: scanline 4s linear infinite;
            opacity: 0.5;
            z-index: 3;
        }
        
        /* Header */
        .header {
            background: var(--void-light);
            border-bottom: 1px solid var(--border);
            padding: 1rem 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        }
        
        .header-left {
            display: flex;
            align-items: center;
            gap: 1.5rem;
        }
        
        .header-title {
            font-family: 'Archivo Black', sans-serif;
            font-size: 1.25rem;
            color: var(--cyan);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            text-shadow: 0 0 20px var(--cyan-glow);
        }
        
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.7rem;
            color: var(--amber);
            text-transform: uppercase;
            letter-spacing: 0.1em;
        }
        
        .status-dot {
            width: 8px;
            height: 8px;
            background: var(--amber);
            border-radius: 50%;
            animation: blink 1s step-end infinite;
            box-shadow: 0 0 10px var(--amber);
        }
        
        .keyboard-hint {
            color: var(--text-dim);
            font-size: 0.7rem;
            padding: 0.25rem 0.5rem;
            background: var(--void);
            border: 1px solid var(--border);
            border-radius: 2px;
        }
        
        .header-right {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        
        /* Buttons */
        .btn {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--cyan);
            padding: 0.5rem 1rem;
            border-radius: 2px;
            cursor: pointer;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.8rem;
            font-weight: 500;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        
        .btn:hover {
            background: var(--cyan-glow);
            border-color: var(--cyan);
            box-shadow: 0 0 20px var(--cyan-glow);
        }
        
        .btn-primary {
            background: var(--cyan-glow);
            border-color: var(--cyan);
            color: var(--cyan);
            font-weight: 700;
        }
        
        .btn-primary:hover {
            background: var(--cyan);
            color: var(--void);
            box-shadow: 0 0 30px var(--cyan-glow);
        }
        
        /* Container */
        .container {
            max-width: 1600px;
            margin: 0 auto;
            padding: 2rem;
            position: relative;
            z-index: 10;
        }
        
        /* Terminal Panel */
        .terminal-panel {
            background: var(--void-card);
            border: 1px solid var(--border);
            border-radius: 4px;
            margin-bottom: 1.5rem;
            position: relative;
            overflow: hidden;
        }
        
        .terminal-panel::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--cyan), transparent);
            opacity: 0.5;
        }
        
        .panel-header {
            padding: 1rem 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: var(--void-light);
        }
        
        .panel-title {
            font-size: 0.8rem;
            color: var(--cyan);
            text-transform: uppercase;
            letter-spacing: 0.15em;
            font-weight: 700;
        }
        
        .panel-body {
            padding: 1.5rem;
        }
        
        /* Form Elements */
        .config-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
        }
        
        .config-group {
            display: flex;
            flex-direction: column;
            gap: 0.375rem;
        }
        
        .config-group label {
            font-size: 0.65rem;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 0.15em;
        }
        
        .config-group input,
        .config-group select {
            background: var(--void);
            border: 1px solid var(--border);
            color: var(--cyan);
            padding: 0.625rem;
            border-radius: 2px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.85rem;
            transition: all 0.3s ease;
        }
        
        .config-group input:focus,
        .config-group select:focus {
            outline: none;
            border-color: var(--cyan);
            box-shadow: 0 0 15px var(--cyan-glow);
        }
        
        .config-actions {
            display: flex;
            gap: 0.75rem;
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border);
            flex-wrap: wrap;
        }
        
        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 1rem;
            margin-bottom: 1.5rem;
        }
        
        .stat-card {
            background: var(--void-card);
            border: 1px solid var(--border);
            padding: 1.5rem;
            border-radius: 4px;
            border-left: 3px solid var(--cyan);
            transition: all 0.3s ease;
            cursor: pointer;
            position: relative;
            overflow: hidden;
        }
        
        .stat-card:hover {
            border-color: var(--cyan);
            box-shadow: 0 0 30px var(--cyan-glow);
            transform: translateY(-2px);
        }
        
        .stat-card.green { border-left-color: var(--green); }
        .stat-card.amber { border-left-color: var(--amber); }
        .stat-card.red { border-left-color: var(--red); }
        
        .stat-label {
            color: var(--text-dim);
            font-size: 0.65rem;
            text-transform: uppercase;
            letter-spacing: 0.15em;
            margin-bottom: 0.75rem;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            color: var(--text-primary);
            line-height: 1;
            font-family: 'JetBrains Mono', monospace;
        }
        
        .stat-card.green .stat-value { color: var(--green); text-shadow: 0 0 20px var(--green-glow); }
        .stat-card.amber .stat-value { color: var(--amber); text-shadow: 0 0 20px var(--amber-glow); }
        .stat-card.red .stat-value { color: var(--red); text-shadow: 0 0 20px var(--red-glow); }
        
        .stat-sub {
            color: var(--text-dim);
            font-size: 0.7rem;
            margin-top: 0.75rem;
        }
        
        /* Content Layout */
        .content-grid {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 1.5rem;
        }
        
        @media (max-width: 1200px) {
            .content-grid { grid-template-columns: 1fr; }
        }
        
        /* Search */
        .search-input {
            flex: 1;
            min-width: 200px;
            background: var(--void);
            border: 1px solid var(--border);
            color: var(--cyan);
            padding: 0.625rem 1rem;
            border-radius: 2px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.85rem;
            transition: all 0.3s ease;
        }
        
        .search-input:focus {
            outline: none;
            border-color: var(--cyan);
            box-shadow: 0 0 15px var(--cyan-glow);
        }
        
        /* Review List */
        .review-list {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }
        
        .review-item {
            background: var(--void);
            border: 1px solid var(--border);
            padding: 1rem;
            border-radius: 4px;
            border-left: 3px solid var(--green);
            transition: all 0.3s ease;
            cursor: pointer;
        }
        
        .review-item:hover {
            border-color: var(--cyan);
            box-shadow: 0 0 20px var(--cyan-glow);
            transform: translateX(4px);
        }
        
        .review-item.partial { border-left-color: var(--amber); }
        .review-item.failed { border-left-color: var(--red); }
        
        .review-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 0.5rem;
            gap: 1rem;
        }
        
        .review-title a {
            color: var(--cyan);
            text-decoration: none;
            font-weight: 600;
            font-size: 0.9rem;
        }
        
        .review-title a:hover {
            text-decoration: underline;
            text-shadow: 0 0 10px var(--cyan-glow);
        }
        
        .review-cost {
            color: var(--green);
            font-weight: 700;
            font-size: 0.9rem;
            text-shadow: 0 0 10px var(--green-glow);
        }
        
        .review-meta {
            color: var(--text-dim);
            font-size: 0.75rem;
            display: flex;
            flex-wrap: wrap;
            gap: 1rem;
        }
        
        /* Provider Badge */
        .provider-badge {
            display: inline-flex;
            align-items: center;
            padding: 0.25rem 0.75rem;
            background: var(--void-light);
            border: 1px solid var(--border);
            border-radius: 2px;
            font-size: 0.7rem;
            color: var(--cyan);
        }
        
        /* Provider Stats */
        .provider-stats-list {
            display: flex;
            flex-direction: column;
        }
        
        .provider-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.875rem 0;
            border-bottom: 1px solid var(--border);
        }
        
        .provider-row:last-child { border-bottom: none; }
        
        .provider-name {
            font-weight: 600;
            color: var(--text-primary);
            font-size: 0.85rem;
        }
        
        .provider-bar {
            width: 100px;
            height: 4px;
            background: var(--void);
            border-radius: 2px;
            overflow: hidden;
            margin-top: 0.25rem;
        }
        
        .provider-bar-fill {
            height: 100%;
            background: var(--cyan);
            box-shadow: 0 0 10px var(--cyan-glow);
            border-radius: 2px;
            transition: width 0.3s ease;
        }
        
        .provider-cost {
            color: var(--cyan);
            font-weight: 700;
            font-size: 0.9rem;
            text-shadow: 0 0 10px var(--cyan-glow);
        }
        
        /* Chart Container */
        .chart-container {
            height: 250px;
            margin-bottom: 1.5rem;
            background: var(--void);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 1rem;
            position: relative;
            overflow: hidden;
        }
        
        .chart-bar {
            fill: var(--cyan);
            opacity: 0.8;
            transition: all 0.3s ease;
            cursor: pointer;
        }
        
        .chart-bar:hover {
            opacity: 1;
            filter: drop-shadow(0 0 8px var(--cyan-glow));
        }
        
        .chart-axis-text {
            fill: var(--text-dim);
            font-size: 10px;
            font-family: 'JetBrains Mono', monospace;
        }
        
        .chart-grid {
            stroke: var(--border);
            stroke-width: 1;
            stroke-dasharray: 4;
        }
        
        /* Loading */
        .loading-state {
            text-align: center;
            padding: 3rem;
            color: var(--text-dim);
        }
        
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--void-lighter);
            border-top-color: var(--cyan);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 1rem;
            box-shadow: 0 0 20px var(--cyan-glow);
        }
        
        /* Toast Notifications */
        .toast-container {
            position: fixed;
            top: 1rem;
            right: 1rem;
            z-index: 1000;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        
        .toast {
            background: var(--void-card);
            border: 1px solid var(--border);
            border-left: 3px solid var(--cyan);
            border-radius: 4px;
            padding: 1rem 1.5rem;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.8);
            color: var(--text-primary);
            font-size: 0.85rem;
            min-width: 300px;
            animation: slideIn 300ms ease;
        }
        
        .toast.success { border-left-color: var(--green); }
        .toast.error { border-left-color: var(--red); }
        .toast.warning { border-left-color: var(--amber); }
        
        .toast-exit {
            animation: slideOut 300ms ease forwards;
        }
        
        /* Error State */
        .error-state {
            background: rgba(255, 51, 102, 0.1);
            border: 1px solid var(--red);
            border-left: 4px solid var(--red);
            padding: 1rem;
            border-radius: 4px;
            margin-bottom: 1rem;
            color: var(--red);
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }
        
        /* Empty State */
        .empty-state {
            text-align: center;
            padding: 4rem;
            color: var(--text-dim);
        }
        
        /* Modal */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(10, 10, 15, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            opacity: 0;
            visibility: hidden;
            transition: all 0.3s ease;
            backdrop-filter: blur(4px);
        }
        
        .modal-overlay.active {
            opacity: 1;
            visibility: visible;
        }
        
        .modal {
            background: var(--void-card);
            border: 1px solid var(--border);
            border-radius: 4px;
            width: 90%;
            max-width: 800px;
            max-height: 90vh;
            overflow: hidden;
            transform: scale(0.95);
            transition: transform 0.3s ease;
            box-shadow: 0 0 60px rgba(0, 0, 0, 0.8);
        }
        
        .modal-overlay.active .modal {
            transform: scale(1);
        }
        
        .modal-header {
            padding: 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: var(--void-light);
        }
        
        .modal-title {
            font-size: 1rem;
            color: var(--cyan);
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.1em;
        }
        
        .modal-close {
            background: none;
            border: none;
            color: var(--text-dim);
            font-size: 1.5rem;
            cursor: pointer;
            padding: 0.25rem;
            transition: color 0.3s ease;
        }
        
        .modal-close:hover {
            color: var(--red);
        }
        
        .modal-body {
            padding: 1.5rem;
            overflow-y: auto;
            max-height: calc(90vh - 80px);
        }
        
        /* Pagination */
        .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 0.5rem;
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border);
        }
        
        .pagination-btn {
            background: var(--void);
            border: 1px solid var(--border);
            color: var(--cyan);
            padding: 0.5rem 0.75rem;
            border-radius: 2px;
            cursor: pointer;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.8rem;
            min-width: 36px;
            transition: all 0.3s ease;
        }
        
        .pagination-btn:hover:not(:disabled) {
            background: var(--cyan-glow);
            border-color: var(--cyan);
            box-shadow: 0 0 15px var(--cyan-glow);
        }
        
        .pagination-btn:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }
        
        .pagination-btn.active {
            background: var(--cyan);
            border-color: var(--cyan);
            color: var(--void);
            font-weight: 700;
        }
        
        /* Help Modal */
        .help-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1.5rem;
        }
        
        .help-section h3 {
            color: var(--cyan);
            font-size: 0.8rem;
            margin-bottom: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.1em;
        }
        
        .help-item {
            display: flex;
            justify-content: space-between;
            padding: 0.5rem 0;
            border-bottom: 1px solid var(--border);
            font-size: 0.85rem;
            color: var(--text-secondary);
        }
        
        .help-key {
            font-family: 'JetBrains Mono', monospace;
            background: var(--void);
            border: 1px solid var(--border);
            padding: 0.125rem 0.5rem;
            border-radius: 2px;
            font-size: 0.75rem;
            color: var(--cyan);
        }
        
        /* Toggle Switch */
        .toggle-wrapper {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            color: var(--text-dim);
            font-size: 0.8rem;
            cursor: pointer;
        }
        
        .toggle-wrapper input[type="checkbox"] {
            appearance: none;
            width: 40px;
            height: 20px;
            background: var(--void);
            border: 1px solid var(--border);
            border-radius: 10px;
            position: relative;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .toggle-wrapper input[type="checkbox"]::after {
            content: '';
            position: absolute;
            width: 14px;
            height: 14px;
            background: var(--text-dim);
            border-radius: 50%;
            top: 2px;
            left: 2px;
            transition: all 0.3s ease;
        }
        
        .toggle-wrapper input[type="checkbox"]:checked {
            background: var(--cyan-glow);
            border-color: var(--cyan);
        }
        
        .toggle-wrapper input[type="checkbox"]:checked::after {
            background: var(--cyan);
            left: 22px;
            box-shadow: 0 0 10px var(--cyan-glow);
        }
        
        /* Responsive */
        @media (max-width: 768px) {
            .header { padding: 1rem; }
            .header-title { font-size: 1rem; }
            .keyboard-hint { display: none; }
            .container { padding: 1rem; }
            .config-grid { grid-template-columns: 1fr; }
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .stat-value { font-size: 1.5rem; }
            .content-grid { grid-template-columns: 1fr; }
        }
        
        @media (max-width: 480px) {
            .stats-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="scanline-bar"></div>
    
    <header class="header" role="banner">
        <div class="header-left">
            <div class="header-title">CODE-REVIEWER</div>
            <div class="status-indicator">
                <span class="status-dot"></span>
                <span>SYSTEM ONLINE</span>
            </div>
            <span class="keyboard-hint">[?] HELP</span>
        </div>
        <div class="header-right">
            <label class="toggle-wrapper" title="Toggle auto-refresh">
                <input type="checkbox" id="autoRefresh" checked>
                <span>AUTO_REFRESH</span>
            </label>
            <button class="btn" onclick="showHelpModal()" title="Help">[?]</button>
            <form method="POST" action="/dashboard/logout">
                <button type="submit" class="btn">[LOGOUT]</button>
            </form>
        </div>
    </header>

    <main class="container">
        <!-- Configuration Panel -->
        <section class="terminal-panel" aria-labelledby="config-title">
            <div class="panel-header">
                <span class="panel-title" id="config-title">// CONFIGURATION</span>
            </div>
            <div class="panel-body">
                <div class="config-grid">
                    <div class="config-group">
                        <label for="preset">QUICK_PRESET</label>
                        <select id="preset" onchange="loadPreset()">
                            <option value="">-- SELECT_PRESET --</option>
                            <option value="Rareminds-eym/embedding-worker">Rareminds-eym/embedding-worker</option>
                        </select>
                    </div>
                    <div class="config-group">
                        <label for="owner">REPO_OWNER</label>
                        <input type="text" id="owner" placeholder="e.g., facebook" autocomplete="off">
                    </div>
                    <div class="config-group">
                        <label for="repo">REPO_NAME</label>
                        <input type="text" id="repo" placeholder="e.g., react" autocomplete="off">
                    </div>
                    <div class="config-group">
                        <label for="startDate">START_DATE</label>
                        <input type="date" id="startDate">
                    </div>
                    <div class="config-group">
                        <label for="endDate">END_DATE</label>
                        <input type="date" id="endDate">
                    </div>
                    <div class="config-group">
                        <label for="limit">LIMIT</label>
                        <select id="limit">
                            <option value="10">10</option>
                            <option value="20" selected>20</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                            <option value="200">200</option>
                        </select>
                    </div>
                    <div class="config-group">
                        <label for="sortBy">SORT_BY</label>
                        <select id="sortBy">
                            <option value="newest">NEWEST_FIRST</option>
                            <option value="oldest">OLDEST_FIRST</option>
                            <option value="cost-desc">COST_HIGH_LOW</option>
                            <option value="cost-asc">COST_LOW_HIGH</option>
                            <option value="tokens-desc">TOKENS_HIGH_LOW</option>
                        </select>
                    </div>
                </div>
                <div class="config-actions">
                    <button class="btn btn-primary" onclick="loadData()">
                        [EXECUTE_QUERY]
                    </button>
                    <button class="btn" onclick="exportData('csv')">
                        [EXPORT_CSV]
                    </button>
                    <button class="btn" onclick="exportData('json')">
                        [EXPORT_JSON]
                    </button>
                    <button class="btn" onclick="clearFilters()">
                        [RESET]
                    </button>
                </div>
            </div>
        </section>

        <!-- Error Container -->
        <div id="errorContainer"></div>

        <!-- Loading State -->
        <div id="loadingState" class="loading-state" style="display: none;">
            <div class="spinner"></div>
            <p>// INITIALIZING DATA STREAM...</p>
        </div>

        <!-- Stats Grid -->
        <div id="statsSection" style="display: none;">
            <div class="stats-grid" id="statsGrid"></div>

            <div class="content-grid">
                <!-- Main Content -->
                <section class="terminal-panel" aria-labelledby="reviews-title">
                    <div class="panel-header">
                        <h2 class="panel-title" id="reviews-title">// REVIEW_LOG</h2>
                        <div style="display: flex; gap: 0.5rem;">
                            <input 
                                type="text" 
                                class="search-input" 
                                id="searchInput" 
                                placeholder="SEARCH_PR..."
                                autocomplete="off"
                            >
                        </div>
                    </div>
                    <div class="panel-body">
                        <div class="chart-container" id="costChart">
                            <svg class="chart-svg" id="costChartSvg"></svg>
                        </div>
                        <div id="reviewsList" class="review-list"></div>
                        <div class="pagination" id="pagination"></div>
                    </div>
                </section>

                <!-- Sidebar -->
                <aside class="terminal-panel" aria-labelledby="sidebar-title">
                    <div class="panel-header">
                        <h2 class="panel-title" id="sidebar-title">// PROVIDER_STATS</h2>
                    </div>
                    <div class="panel-body">
                        <div id="byProvider" class="provider-stats-list"></div>
                    </div>
                </aside>
            </div>
        </div>

        <!-- Empty State -->
        <div id="emptyState" class="empty-state" style="display: block;">
            <div style="font-size: 4rem; margin-bottom: 1rem; opacity: 0.3;">⌨</div>
            <p>// ENTER REPOSITORY PARAMETERS TO INITIALIZE SCAN</p>
        </div>
    </main>

    <!-- Toast Container -->
    <div class="toast-container" id="toastContainer"></div>

    <!-- Help Modal -->
    <div class="modal-overlay" id="helpModal" onclick="hideHelpModal(event)">
        <div class="modal" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2 class="modal-title">// KEYBOARD_SHORTCUTS</h2>
                <button class="modal-close" onclick="hideHelpModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="help-grid">
                    <div class="help-section">
                        <h3>NAVIGATION</h3>
                        <div class="help-item">
                            <span>SHOW_HELP</span>
                            <kbd class="help-key">?</kbd>
                        </div>
                        <div class="help-item">
                            <span>FOCUS_SEARCH</span>
                            <kbd class="help-key">/</kbd>
                        </div>
                        <div class="help-item">
                            <span>EXECUTE_QUERY</span>
                            <kbd class="help-key">CTRL+ENTER</kbd>
                        </div>
                    </div>
                    <div class="help-section">
                        <h3>ACTIONS</h3>
                        <div class="help-item">
                            <span>EXPORT_CSV</span>
                            <kbd class="help-key">CTRL+S</kbd>
                        </div>
                        <div class="help-item">
                            <span>CLEAR_FILTERS</span>
                            <kbd class="help-key">ESC</kbd>
                        </div>
                        <div class="help-item">
                            <span>TOGGLE_REFRESH</span>
                            <kbd class="help-key">R</kbd>
                        </div>
                    </div>
                    <div class="help-section">
                        <h3>PAGINATION</h3>
                        <div class="help-item">
                            <span>NEXT_PAGE</span>
                            <kbd class="help-key">J</kbd>
                        </div>
                        <div class="help-item">
                            <span>PREV_PAGE</span>
                            <kbd class="help-key">K</kbd>
                        </div>
                        <div class="help-item">
                            <span>FIRST_PAGE</span>
                            <kbd class="help-key">G+G</kbd>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Detail Modal -->
    <div class="modal-overlay" id="detailModal" onclick="hideDetailModal(event)">
        <div class="modal" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2 class="modal-title" id="detailTitle">// REVIEW_DETAILS</h2>
                <button class="modal-close" onclick="hideDetailModal()">&times;</button>
            </div>
            <div class="modal-body" id="detailContent"></div>
        </div>
    </div>

    <script>
        /**
         * Dashboard State Management
         */
        const state = {
            reviews: [],
            filteredReviews: [],
            stats: null,
            currentPage: 1,
            pageSize: 10,
            autoRefresh: true,
            refreshInterval: null,
            isLoading: false,
            lastLoadTime: null,
            chartData: null
        };

        const CONFIG = {
            REFRESH_INTERVAL: 60000, // 60 seconds
            DEBOUNCE_DELAY: 300,
            MAX_PAGES_SHOWN: 5
        };

        /**
         * Initialize Dashboard
         */
        document.addEventListener('DOMContentLoaded', () => {
            initializeDates();
            setupEventListeners();
            setupKeyboardShortcuts();
            
            // Load from URL params if present
            loadFromUrlParams();
        });

        function initializeDates() {
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 30);
            
            document.getElementById('endDate').value = formatDateForInput(endDate);
            document.getElementById('startDate').value = formatDateForInput(startDate);
        }

        function formatDateForInput(date) {
            return date.toISOString().split('T')[0];
        }

        function setupEventListeners() {
            // Auto-refresh toggle
            document.getElementById('autoRefresh').addEventListener('change', (e) => {
                state.autoRefresh = e.target.checked;
                if (state.autoRefresh) {
                    startAutoRefresh();
                } else {
                    stopAutoRefresh();
                }
            });

            // Search with debounce
            const searchInput = document.getElementById('searchInput');
            let debounceTimer;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    filterReviews(e.target.value);
                }, CONFIG.DEBOUNCE_DELAY);
            });

            // Enter to load
            document.getElementById('owner').addEventListener('keypress', handleEnter);
            document.getElementById('repo').addEventListener('keypress', handleEnter);
        }

        function handleEnter(e) {
            if (e.key === 'Enter') {
                loadData();
            }
        }

        function setupKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                // Ignore if in input
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
                    if (e.key === 'Escape') {
                        e.target.blur();
                    }
                    return;
                }

                switch (e.key) {
                    case '?':
                        e.preventDefault();
                        showHelpModal();
                        break;
                    case '/':
                        e.preventDefault();
                        document.getElementById('searchInput').focus();
                        break;
                    case 'r':
                    case 'R':
                        const checkbox = document.getElementById('autoRefresh');
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change'));
                        showToast('Auto-refresh ' + (checkbox.checked ? 'enabled' : 'disabled'), 'info');
                        break;
                    case 'j':
                        nextPage();
                        break;
                    case 'k':
                        prevPage();
                        break;
                    case 'Escape':
                        hideHelpModal();
                        hideDetailModal();
                        break;
                }

                // Ctrl/Cmd shortcuts
                if (e.ctrlKey || e.metaKey) {
                    switch (e.key) {
                        case 'Enter':
                            e.preventDefault();
                            loadData();
                            break;
                        case 's':
                            e.preventDefault();
                            exportData('csv');
                            break;
                    }
                }
            });
        }

        function loadFromUrlParams() {
            const params = new URLSearchParams(window.location.search);
            const owner = params.get('owner');
            const repo = params.get('repo');
            
            if (owner && repo) {
                document.getElementById('owner').value = owner;
                document.getElementById('repo').value = repo;
                loadData();
            }
        }

        /**
         * Load Preset Configuration
         */
        function loadPreset() {
            const preset = document.getElementById('preset').value;
            if (!preset) return;
            
            const [owner, repo] = preset.split('/');
            document.getElementById('owner').value = owner;
            document.getElementById('repo').value = repo;
            
            // Clear preset selection
            document.getElementById('preset').value = '';
            
            // Optionally auto-load data
            showToast('Preset loaded: ' + owner + '/' + repo, 'info');
        }

        /**
         * Data Loading
         */
        async function loadData() {
            const owner = document.getElementById('owner').value.trim();
            const repo = document.getElementById('repo').value.trim();
            
            if (!owner || !repo) {
                showToast('Please enter repository owner and name', 'warning');
                return;
            }

            // Update URL
            const url = new URL(window.location);
            url.searchParams.set('owner', owner);
            url.searchParams.set('repo', repo);
            window.history.replaceState({}, '', url);

            state.isLoading = true;
            showLoading(true);
            hideError();

            try {
                const limit = document.getElementById('limit').value;
                const [stats, reviews] = await Promise.all([
                    fetchWithErrorHandling(\`/usage/\${owner}/\${repo}/stats\`),
                    fetchWithErrorHandling(\`/usage/\${owner}/\${repo}?limit=\${limit}\`)
                ]);

                state.stats = stats;
                state.reviews = reviews;
                state.filteredReviews = filterByDateRange(reviews);
                state.currentPage = 1;
                state.lastLoadTime = new Date();

                applySorting();
                displayStats(stats);
                displayReviews();
                renderCharts();
                
                showLoading(false);
                document.getElementById('statsSection').style.display = 'block';
                document.getElementById('emptyState').style.display = 'none';

                // Start auto-refresh
                if (state.autoRefresh) {
                    startAutoRefresh();
                }

                showToast(\`Loaded \${reviews.length} reviews\`, 'success');
            } catch (err) {
                showLoading(false);
                showError('Failed to load data: ' + err.message);
                showToast('Error loading data', 'error');
            } finally {
                state.isLoading = false;
            }
        }

        function filterByDateRange(reviews) {
            const startDate = document.getElementById('startDate').value;
            const endDate = document.getElementById('endDate').value;
            
            if (!startDate && !endDate) return reviews;
            
            const start = startDate ? new Date(startDate) : new Date(0);
            const end = endDate ? new Date(endDate) : new Date();
            end.setHours(23, 59, 59, 999);
            
            return reviews.filter(r => {
                const reviewDate = new Date(r.startTime);
                return reviewDate >= start && reviewDate <= end;
            });
        }

        function applySorting() {
            const sortBy = document.getElementById('sortBy').value;
            
            state.filteredReviews.sort((a, b) => {
                switch (sortBy) {
                    case 'newest':
                        return new Date(b.startTime) - new Date(a.startTime);
                    case 'oldest':
                        return new Date(a.startTime) - new Date(b.startTime);
                    case 'cost-desc':
                        return b.estimatedCost - a.estimatedCost;
                    case 'cost-asc':
                        return a.estimatedCost - b.estimatedCost;
                    case 'tokens-desc':
                        return b.totalTokens - a.totalTokens;
                    default:
                        return 0;
                }
            });
        }

        /**
         * Display Functions
         */
        function displayStats(stats) {
            const grid = document.getElementById('statsGrid');
            const totalCost = stats.totalCost || 0;
            const avgCost = stats.avgCostPerReview || 0;
            const totalTokens = stats.totalTokens || 0;
            const avgTokens = stats.avgTokensPerReview || 0;
            
            grid.innerHTML = \`
                <div class="stat-card" onclick="scrollToReviews()">
                    <div class="stat-label">📋 Total Reviews</div>
                    <div class="stat-value">\${formatNumber(stats.totalReviews || 0)}</div>
                    <div class="stat-sub">Across all providers</div>
                </div>
                <div class="stat-card amber">
                    <div class="stat-label">💰 Total Cost</div>
                    <div class="stat-value">$\${totalCost.toFixed(2)}</div>
                    <div class="stat-sub">Avg $\${avgCost.toFixed(4)}/review</div>
                </div>
                <div class="stat-card green">
                    <div class="stat-label">🪙 Total Tokens</div>
                    <div class="stat-value">\${formatNumber(totalTokens)}</div>
                    <div class="stat-sub">Avg \${formatNumber(Math.round(avgTokens))}/review</div>
                </div>
                <div class="stat-card purple">
                    <div class="stat-label">⏱️ Avg Duration</div>
                    <div class="stat-value">\${formatDuration(stats.avgDurationMs)}</div>
                    <div class="stat-sub">Per review</div>
                </div>
            \`;
        }

        function displayReviews() {
            const container = document.getElementById('reviewsList');
            const start = (state.currentPage - 1) * state.pageSize;
            const end = start + state.pageSize;
            const pageReviews = state.filteredReviews.slice(start, end);
            
            if (pageReviews.length === 0) {
                container.innerHTML = '<div class="empty-state">No reviews found</div>';
                renderPagination(0);
                return;
            }
            
            container.innerHTML = pageReviews.map(review => renderReviewItem(review)).join('');
            renderPagination(state.filteredReviews.length);
        }

        function renderReviewItem(review) {
            const date = new Date(review.startTime).toLocaleString();
            const duration = formatDuration(review.durationMs);
            
            return \`
                <article class="review-item \${review.status}" onclick="showReviewDetail('\${review.prNumber}')">
                    <div class="review-header">
                        <div class="review-title">
                            <a href="https://github.com/\${review.repository}/pull/\${review.prNumber}" 
                               target="_blank" 
                               rel="noopener noreferrer"
                               onclick="event.stopPropagation()">
                                PR #\${review.prNumber}
                            </a>
                        </div>
                        <div class="review-cost">$\${review.estimatedCost.toFixed(4)}</div>
                    </div>
                    <div class="review-meta">
                        <span>📅 \${date}</span>
                        <span>⏱️ \${duration}</span>
                        <span>🪙 \${formatNumber(review.totalTokens)} tokens</span>
                        <span>📁 \${review.filesReviewed} files</span>
                        <span>📝 \${review.findingsCount} findings</span>
                        <span class="provider-badge">\${review.provider}</span>
                    </div>
                </article>
            \`;
        }

        function renderPagination(totalItems) {
            const totalPages = Math.ceil(totalItems / state.pageSize);
            const container = document.getElementById('pagination');
            
            if (totalPages <= 1) {
                container.innerHTML = '';
                return;
            }
            
            let html = '';
            
            // Prev button
            html += \`<button class="pagination-btn" onclick="goToPage(\${state.currentPage - 1})" \${state.currentPage === 1 ? 'disabled' : ''}>←</button>\`;
            
            // Page numbers
            let startPage = Math.max(1, state.currentPage - Math.floor(CONFIG.MAX_PAGES_SHOWN / 2));
            let endPage = Math.min(totalPages, startPage + CONFIG.MAX_PAGES_SHOWN - 1);
            
            if (endPage - startPage < CONFIG.MAX_PAGES_SHOWN - 1) {
                startPage = Math.max(1, endPage - CONFIG.MAX_PAGES_SHOWN + 1);
            }
            
            if (startPage > 1) {
                html += '<button class="pagination-btn" onclick="goToPage(1)">1</button>';
                if (startPage > 2) html += '<span>...</span>';
            }
            
            for (let i = startPage; i <= endPage; i++) {
                html += \`<button class="pagination-btn \${i === state.currentPage ? 'active' : ''}" onclick="goToPage(\${i})">\${i}</button>\`;
            }
            
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) html += '<span>...</span>';
                html += \`<button class="pagination-btn" onclick="goToPage(\${totalPages})">\${totalPages}</button>\`;
            }
            
            // Next button
            html += \`<button class="pagination-btn" onclick="goToPage(\${state.currentPage + 1})" \${state.currentPage === totalPages ? 'disabled' : ''}>→</button>\`;
            
            container.innerHTML = html;
        }

        function goToPage(page) {
            const totalPages = Math.ceil(state.filteredReviews.length / state.pageSize);
            if (page < 1 || page > totalPages) return;
            
            state.currentPage = page;
            displayReviews();
            document.getElementById('reviewsList').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function nextPage() {
            goToPage(state.currentPage + 1);
        }

        function prevPage() {
            goToPage(state.currentPage - 1);
        }

        /**
         * Chart Rendering (SVG)
         */
        function renderCharts() {
            renderCostChart();
            renderProviderChart();
        }

        function renderCostChart() {
            const svg = document.getElementById('costChartSvg');
            const width = svg.clientWidth || 600;
            const height = svg.clientHeight || 250;
            const padding = { top: 20, right: 30, bottom: 40, left: 50 };
            
            // Prepare data - group by date
            const data = state.filteredReviews.reduce((acc, review) => {
                const date = new Date(review.startTime).toLocaleDateString();
                acc[date] = (acc[date] || 0) + review.estimatedCost;
                return acc;
            }, {});
            
            const entries = Object.entries(data).sort((a, b) => new Date(a[0]) - new Date(b[0]));
            if (entries.length === 0) {
                svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#64748b">No data available</text>';
                return;
            }
            
            const maxCost = Math.max(...entries.map(e => e[1]));
            const chartWidth = width - padding.left - padding.right;
            const chartHeight = height - padding.top - padding.bottom;
            
            const barWidth = Math.max(10, chartWidth / entries.length - 2);
            
            let html = '';
            
            // Grid lines
            for (let i = 0; i <= 5; i++) {
                const y = padding.top + (chartHeight * i / 5);
                html += \`<line class="chart-grid" x1="\${padding.left}" y1="\${y}" x2="\${width - padding.right}" y2="\${y}" />\`;
                html += \`<text class="chart-axis-text" x="\${padding.left - 10}" y="\${y + 3}" text-anchor="end">\$\${(maxCost * (5 - i) / 5).toFixed(1)}</text>\`;
            }
            
            // Bars
            entries.forEach((entry, i) => {
                const [date, cost] = entry;
                const x = padding.left + i * (chartWidth / entries.length) + (chartWidth / entries.length - barWidth) / 2;
                const barHeight = (cost / maxCost) * chartHeight;
                const y = padding.top + chartHeight - barHeight;
                
                html += \`<rect class="chart-bar" x="\${x}" y="\${y}" width="\${barWidth}" height="\${barHeight}" data-date="\${date}" data-cost="\${cost.toFixed(2)}" />\`;
            });
            
            // X-axis labels (show every nth label if many)
            const labelInterval = Math.ceil(entries.length / 10);
            entries.forEach((entry, i) => {
                if (i % labelInterval === 0) {
                    const x = padding.left + i * (chartWidth / entries.length) + chartWidth / entries.length / 2;
                    const date = new Date(entry[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                    html += \`<text class="chart-axis-text" x="\${x}" y="\${height - 10}" text-anchor="middle" transform="rotate(-45, \${x}, \${height - 10})">\${date}</text>\`;
                }
            });
            
            svg.innerHTML = html;
        }

        function renderProviderChart() {
            const container = document.getElementById('byProvider');
            const stats = state.stats;
            
            if (!stats || !stats.byProvider) {
                container.innerHTML = '<div class="empty-state">No provider data</div>';
                return;
            }
            
            const providers = Object.entries(stats.byProvider);
            const maxCost = Math.max(...providers.map(([, data]) => data.cost));
            
            container.innerHTML = providers.map(([name, data]) => {
                const percentage = (data.cost / maxCost) * 100;
                
                return \`
                    <div class="provider-row">
                        <div class="provider-info">
                            <span class="provider-name">\${name}</span>
                            <div class="provider-bar">
                                <div class="provider-bar-fill" style="width: \${percentage}%"></div>
                            </div>
                        </div>
                        <div class="provider-numbers">
                            <div class="provider-cost">$\${data.cost.toFixed(2)}</div>
                            <div>\${data.reviews} reviews</div>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        /**
         * Filtering & Search
         */
        function filterReviews(query) {
            if (!query) {
                state.filteredReviews = filterByDateRange(state.reviews);
            } else {
                const lowerQuery = query.toLowerCase();
                state.filteredReviews = state.reviews.filter(r => {
                    return r.prNumber.toString().includes(lowerQuery) ||
                           r.repository?.toLowerCase().includes(lowerQuery) ||
                           r.provider?.toLowerCase().includes(lowerQuery);
                });
                state.filteredReviews = filterByDateRange(state.filteredReviews);
            }
            
            state.currentPage = 1;
            applySorting();
            displayReviews();
        }

        function clearFilters() {
            document.getElementById('owner').value = '';
            document.getElementById('repo').value = '';
            document.getElementById('searchInput').value = '';
            initializeDates();
            
            document.getElementById('statsSection').style.display = 'none';
            document.getElementById('emptyState').style.display = 'block';
            
            // Clear URL params
            window.history.replaceState({}, '', window.location.pathname);
            
            stopAutoRefresh();
            showToast('Filters cleared', 'info');
        }

        /**
         * Auto-refresh
         */
        function startAutoRefresh() {
            stopAutoRefresh();
            if (state.autoRefresh && state.stats) {
                state.refreshInterval = setInterval(() => {
                    if (!state.isLoading) {
                        loadData();
                    }
                }, CONFIG.REFRESH_INTERVAL);
            }
        }

        function stopAutoRefresh() {
            if (state.refreshInterval) {
                clearInterval(state.refreshInterval);
                state.refreshInterval = null;
            }
        }

        /**
         * Data Export
         */
        function exportData(format) {
            if (!state.reviews || state.reviews.length === 0) {
                showToast('No data to export', 'warning');
                return;
            }
            
            const data = state.filteredReviews;
            const timestamp = new Date().toISOString().split('T')[0];
            const filename = \`code-reviewer-\${document.getElementById('owner').value}-\${document.getElementById('repo').value}-\${timestamp}\`;
            
            if (format === 'csv') {
                exportCSV(data, filename);
            } else if (format === 'json') {
                exportJSON(data, filename);
            }
        }

        function exportCSV(data, filename) {
            const headers = ['PR Number', 'Date', 'Provider', 'Cost', 'Tokens', 'Files', 'Findings', 'Duration (ms)', 'Status'];
            const rows = data.map(r => [
                r.prNumber,
                new Date(r.startTime).toISOString(),
                r.provider,
                r.estimatedCost.toFixed(4),
                r.totalTokens,
                r.filesReviewed,
                r.findingsCount,
                r.durationMs,
                r.status
            ]);
            
            const csv = [headers, ...rows]
                .map(row => row.map(cell => \`"\${cell}"\`).join(','))
                .join('\\n');
            
            downloadFile(csv, \`\${filename}.csv\`, 'text/csv');
            showToast(\`Exported \${data.length} reviews to CSV\`, 'success');
        }

        function exportJSON(data, filename) {
            const json = JSON.stringify(data, null, 2);
            downloadFile(json, \`\${filename}.json\`, 'application/json');
            showToast(\`Exported \${data.length} reviews to JSON\`, 'success');
        }

        function downloadFile(content, filename, type) {
            const blob = new Blob([content], { type });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        /**
         * Detail Modal
         */
        function showReviewDetail(prNumber) {
            const review = state.reviews.find(r => r.prNumber.toString() === prNumber);
            if (!review) return;
            
            const content = document.getElementById('detailContent');
            const title = document.getElementById('detailTitle');
            
            title.textContent = 'PR #' + review.prNumber + ' Details';
            content.innerHTML = '<div style="display: grid; gap: 1rem;">' +
                '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">' +
                    '<div>' +
                        '<strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Repository</strong>' +
                        '<p>' + escapeHtml(review.repository) + '</p>' +
                    '</div>' +
                    '<div>' +
                        '<strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Provider</strong>' +
                        '<p>' + escapeHtml(review.provider) + '</p>' +
                    '</div>' +
                    '<div>' +
                        '<strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Model</strong>' +
                        '<p>' + escapeHtml(review.model || 'N/A') + '</p>' +
                    '</div>' +
                    '<div>' +
                        '<strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Status</strong>' +
                        '<p><span class="provider-badge">' + escapeHtml(review.status) + '</span></p>' +
                    '</div>' +
                    '<div>' +
                        '<strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Cost</strong>' +
                        '<p style="color: var(--accent-green); font-weight: 600;">$' + review.estimatedCost.toFixed(4) + '</p>' +
                    '</div>' +
                '</div>' +
                '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; padding: 1rem; background: var(--bg-primary); border-radius: var(--radius-md);">' +
                    '<div style="text-align: center;">' +
                        '<div style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">' + formatNumber(review.totalTokens) + '</div>' +
                        '<div style="font-size: 0.75rem; color: var(--text-muted);">Tokens</div>' +
                    '</div>' +
                    '<div style="text-align: center;">' +
                        '<div style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">' + review.filesReviewed + '</div>' +
                        '<div style="font-size: 0.75rem; color: var(--text-muted);">Files</div>' +
                    '</div>' +
                    '<div style="text-align: center;">' +
                        '<div style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">' + review.findingsCount + '</div>' +
                        '<div style="font-size: 0.75rem; color: var(--text-muted);">Findings</div>' +
                    '</div>' +
                '</div>' +
                '<div>' +
                    '<strong style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">Timeline</strong>' +
                    '<p>Started: ' + new Date(review.startTime).toLocaleString() + '</p>' +
                    '<p>Duration: ' + formatDuration(review.durationMs) + '</p>' +
                '</div>' +
                '<div>' +
                    '<a href="https://github.com/' + review.repository + '/pull/' + review.prNumber + '"' +
                       ' target="_blank"' +
                       ' class="btn btn-primary"' +
                       ' style="display: inline-flex; text-decoration: none;">' +
                        '🔗 Open on GitHub' +
                    '</a>' +
                '</div>' +
            '</div>';
            
            document.getElementById('detailModal').classList.add('active');
        }

        function hideDetailModal(e) {
            if (!e || e.target.id === 'detailModal') {
                document.getElementById('detailModal').classList.remove('active');
            }
        }

        /**
         * Help Modal
         */
        function showHelpModal() {
            document.getElementById('helpModal').classList.add('active');
        }

        function hideHelpModal(e) {
            if (!e || e.target.id === 'helpModal') {
                document.getElementById('helpModal').classList.remove('active');
            }
        }

        /**
         * Toast Notifications
         */
        function showToast(message, type = 'info', duration = 3000) {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = \`toast \${type}\`;
            toast.textContent = message;
            container.appendChild(toast);
            
            setTimeout(() => {
                toast.classList.add('toast-exit');
                toast.addEventListener('animationend', () => {
                    toast.remove();
                });
            }, duration);
        }

        /**
         * Error Handling
         */
        function showError(message) {
            const container = document.getElementById('errorContainer');
            container.innerHTML = \`
                <div class="error-state" role="alert">
                    <span>⚠️ \${escapeHtml(message)}</span>
                    <button onclick="retryLoad()">🔄 Retry</button>
                </div>
            \`;
        }

        function hideError() {
            document.getElementById('errorContainer').innerHTML = '';
        }

        function retryLoad() {
            hideError();
            loadData();
        }

        function showLoading(show) {
            document.getElementById('loadingState').style.display = show ? 'block' : 'none';
        }

        /**
         * Utilities
         */
        function formatNumber(num) {
            if (!num) return '0';
            return num.toLocaleString();
        }

        function formatDuration(ms) {
            if (!ms) return '-';
            const seconds = Math.round(ms / 1000);
            if (seconds < 60) return seconds + 's';
            const minutes = Math.floor(seconds / 60);
            const remaining = seconds % 60;
            return remaining > 0 ? \`\${minutes}m \${remaining}s\` : \`\${minutes}m\`;
        }

        function scrollToReviews() {
            document.getElementById('reviews-title').scrollIntoView({ behavior: 'smooth' });
        }

        /**
         * XSS Protection - Escape HTML entities
         */
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        /**
         * Page Visibility API - Pause auto-refresh when tab hidden
         */
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopAutoRefresh();
            } else if (state.autoRefresh && state.stats) {
                startAutoRefresh();
                // Refresh data if tab was hidden for > 5 minutes
                if (state.lastLoadTime && Date.now() - state.lastLoadTime > 300000) {
                    loadData();
                }
            }
        });

        /**
         * Handle fetch errors with specific HTTP codes
         */
        async function fetchWithErrorHandling(url) {
            const response = await fetch(url);
            
            if (!response.ok) {
                let message = 'Failed to load data';
                switch (response.status) {
                    case 401:
                        message = 'Unauthorized - Invalid API key';
                        break;
                    case 403:
                        message = 'Forbidden - Access denied';
                        break;
                    case 404:
                        message = 'No data found for this repository';
                        break;
                    case 429:
                        const retryAfter = response.headers.get('Retry-After') || '60';
                        message = 'Rate limited - Retry after ' + retryAfter + 's';
                        break;
                    case 500:
                    case 502:
                    case 503:
                        message = 'Server error - Please try again later';
                        break;
                }
                throw new Error(message);
            }
            
            return response.json();
        }
    </script>
</body>
</html>`;
