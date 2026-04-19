import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        claude: {
          bg: '#F7F4ED',
          surface: '#FAF9F5',
          border: '#E8E4DA',
          ink: '#141413',
          muted: '#666563',
          accent: '#D97757',
          accentHover: '#C66A4A',
        },
        night: {
          bg: '#1F1E1C',
          surface: '#262624',
          border: '#3A3836',
          ink: '#E8E6E1',
          muted: '#9A9691',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        serif: ['Tiempos Text', 'Georgia', 'serif'],
      },
      fontSize: {
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '22px'],
        lg: ['16px', '24px'],
        xl: ['18px', '28px'],
      },
      animation: {
        'fade-in': 'fadeIn 180ms ease-out',
        'slide-in': 'slideIn 220ms ease-out',
        'pulse-subtle': 'pulseSubtle 1.4s ease-in-out infinite',
        // Whole-message flash: only used as a fallback when we can't find
        // the search term inside the rendered message DOM.
        'flash-pop': 'flashPop 2200ms ease-out',
        // Word-level flash: wraps just the matched substring with an
        // ephemeral <span>, so only those few characters pulse.
        'flash-match': 'flashMatch 2200ms ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateX(-8px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        // Claude accent (#D97757) → rgb(217, 119, 87). Using literal rgba() so
        // JIT / custom-color alpha edge cases can't silently no-op this.
        flashPop: {
          '0%':   { boxShadow: '0 0 0 3px rgba(217, 119, 87, 0.9)', backgroundColor: 'rgba(217, 119, 87, 0.15)' },
          '60%':  { boxShadow: '0 0 0 3px rgba(217, 119, 87, 0.5)', backgroundColor: 'rgba(217, 119, 87, 0.08)' },
          '100%': { boxShadow: '0 0 0 0 rgba(217, 119, 87, 0)',     backgroundColor: 'rgba(217, 119, 87, 0)' },
        },
        // Inline-text flash — no ring (would break awkwardly across line
        // wraps), just a background color that fades from strong to gone.
        flashMatch: {
          '0%':   { backgroundColor: 'rgba(217, 119, 87, 0.8)' },
          '60%':  { backgroundColor: 'rgba(217, 119, 87, 0.35)' },
          '100%': { backgroundColor: 'rgba(217, 119, 87, 0)' },
        },
      },
    },
  },
  plugins: [typography],
};
