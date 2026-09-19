// Адрес сервера бота, к которому обращается редактор. При переезде на другой хостинг
// меняется здесь и в заголовке Content-Security-Policy для /teacher.html (render.yaml).
export const PROD_API_URL = "https://chinese-drill-bot.onrender.com";

export const DEV = ["localhost", "127.0.0.1"].includes(location.hostname);

// Свой адрес сервера принимается только при локальной разработке: на боевом сайте
// подставить чужой адрес нельзя, иначе данные входа можно было бы отправить не туда.
export const API_URL = (DEV && new URLSearchParams(location.search).get("api")) || PROD_API_URL;
