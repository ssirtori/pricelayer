export default defineNuxtConfig({
  compatibilityVersion: 4,
  srcDir: '.',
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'PriceLayer — How much does your print cost?',
      htmlAttrs: { lang: 'en' },
      meta: [
        {
          name: 'description',
          content: 'Upload a 3MF file and get a filament weight estimate, volume, dimensions and more — all computed in your browser.'
        }
      ]
    }
  }
})