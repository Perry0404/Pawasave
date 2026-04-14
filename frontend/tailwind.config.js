/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        pawa: {
          green: '#00A651',
          'green-light': '#E6F7ED',
          dark: '#1A1A2E',
          gold: '#F5A623',
          purple: '#6C63FF',
        },
      },
    },
  },
  plugins: [],
};
