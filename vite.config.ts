// The game page (index.html, served at /yellow and /crystal) and the picker (landing.html, served at /) are two pages.
export default {
  server: {proxy: {'/api': 'http://localhost:8787'}},
  build: {rollupOptions: {input: {main: 'index.html', landing: 'landing.html'}}},
};
