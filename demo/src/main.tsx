import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { startAnalytics } from './analytics.js';
import { App } from './ui/App.js';

startAnalytics();

const root = document.getElementById('root');
if (root) {
    createRoot(root).render(
        <StrictMode>
            <App />
        </StrictMode>
    );
}
