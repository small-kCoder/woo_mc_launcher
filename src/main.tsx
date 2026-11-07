import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import LauncherProvider from './state/LauncherProvider';
import './styles/tokens.css';
import './styles/glass.css';
import './styles/global.css';
import './styles/layout.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('未找到根节点 #root');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <LauncherProvider>
      <App />
    </LauncherProvider>
  </React.StrictMode>
);
