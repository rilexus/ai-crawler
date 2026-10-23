import { createGlobalStyle, css } from "styled-components";

// Color tokens, named by role. Components use `var(--color-…)` instead of
// literal colors, so the dark palette applies everywhere. Each text color
// has a contrast ratio of at least 4.5:1 on the backgrounds it's used on;
// most are 7:1 or higher.
const light = css`
  --color-bg: #ffffff;
  --color-text: #1f1f1f;
  --color-text-secondary: #595959;
  --color-border: #c4c4c4;
  --color-accent: #0b57d0;
  --color-selected-bg: #e8f0fe;
  --color-hover: rgb(0 0 0 / 4%);
  --color-code-bg: #f6f6f6;
  --color-error: #b00020;
  --color-error-bg: #fce8e6;
  --color-success: #146c2e;
  --color-success-bg: #e6f4ea;
  --color-running: #6a1b9a;
  --color-running-bg: #f3e8fd;
  --color-neutral: #595959;
  --color-neutral-bg: #f0f0f0;
  --color-warning: #7a4100;
  --color-warning-bg: #fef7e0;
`;

const dark = css`
  --color-bg: #131314;
  --color-text: #e3e3e3;
  --color-text-secondary: #a8a8a8;
  --color-border: #444746;
  --color-accent: #a8c7fa;
  --color-selected-bg: #1f3760;
  --color-hover: rgb(255 255 255 / 6%);
  --color-code-bg: #1e1f20;
  --color-error: #f2b8b5;
  --color-error-bg: #601410;
  --color-success: #6dd58c;
  --color-success-bg: #0f5223;
  --color-running: #d7aefb;
  --color-running-bg: #4a0072;
  --color-neutral: #c4c7c5;
  --color-neutral-bg: #303030;
  --color-warning: #ffdf99;
  --color-warning-bg: #3d2c00;
`;

export const GlobalStyle = createGlobalStyle`
  :root {
    color-scheme: light dark;
    ${light}
  }

  @media (prefers-color-scheme: dark) {
    :root {
      ${dark}
    }
  }

  body {
    margin: 0;
    padding: 1.5rem;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  @media (max-width: 40rem) {
    body {
      padding: 1rem;
    }
  }
`;
