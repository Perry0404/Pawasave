/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      screens: {
        xs: '400px',
      },
      colors: {
        pawa: {
          green: '#00A651',
          'green-light': '#E6F7ED',
          dark: '#1A1A2E',
          gold: '#F5A623',
          purple: '#6C63FF',
        },
        // Brand palette used across the /protocol DeFi UI. Matches the logo
        // gradient (#10B981 → #06B6D4). Mirrors Tailwind's emerald scale.
        brand: {
          50:  '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
          950: '#022c22',
        },
      },
    },
  },
  plugins: [],
};
