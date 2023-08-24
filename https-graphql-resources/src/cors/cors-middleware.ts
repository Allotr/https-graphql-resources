
import { Express } from "express";
const cors = require('cors');

function initializeCORS(app: Express) {
    const corsOptions = {
        origin: (origin, next) => {
            // Test for main domain and all subdomains
            if (origin == null || origin === 'https://allotr.eu' || /^https:\/\/.+?\.allotr\.eu$/gm.test(origin)) {
                next(null, true)
            } else {
                next(new Error('Not allowed by CORS'))
            }
        },
        credentials: true // <-- REQUIRED backend setting
    };

    app.use(cors(corsOptions));
}

export { initializeCORS }


