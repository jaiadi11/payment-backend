require('dotenv').config(); // loads .env file

const { Pool } = require('pg'); // PostgreSQL connection pool

// create a pool using database url from .env
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

// export helper functions
module.exports = {
    query: (text, params) => pool.query(text, params), // easy query fn
    getClient: () => pool.connect() // used for transactions
};
