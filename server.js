require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Database Connection (Neon Postgres)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

app.use(express.json());
app.use(express.static(__dirname));

// Static Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Admin Security Middleware
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'super_secret_dash_admin_2026';
function checkAdminAuth(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.admin_key;
    if (key !== ADMIN_SECRET) {
        return res.status(403).json({ error: 'ያልተፈቀደ መዳረሻ! የተሳሳተ የአድሚን ቁልፍ።' });
    }
    next();
}

// ================= SIMULATED BOTS CONTROLLER ================= //
// 🤖 ቦቶች እንዲቆርጡ ከፈለግክ true፤ ማጥፋት ስትፈልግ false አድርገው
const ENABLE_SIMULATED_PLAYERS = true; 

const BOT_NAMES = ["Almush 🌱 SEED 🐾", "Girmay", "Rui costa", "Abuker", "Daniel", "🐐 MARCY 🇪🇷 👻", "JERMIAH", "Hkedi Yeseya", "Alst 🙋 costey", "Meli 🌸", "Roky", "Haymi 🦋", "ዛ Life", "Mastewal", "Alemyehu", "Mohammed", "Alste", "Saha", "Nihaan", "Abel", "Mati", "TAMJA", "Teshome", "toma", "Eyerus", "tamex 💜"];
// Telegram Bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://dashbingo.onrender.com';

bot.start(async (ctx) => {
    const { id, first_name, username } = ctx.from;
    try {
        await pool.query(
            `INSERT INTO users (telegram_id, first_name, username) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (telegram_id) DO UPDATE SET first_name = $2, username = $3`,
            [id, first_name || 'ተጫዋች', username || '']
        );
        ctx.reply(`እንኳን ወደ Dash Bingo ⚡ በደህና መጡ! ጨዋታውን ለመጀመር እና የ 20 ብር ቦነስዎን ለመውሰድ ከታች ያለውን ይጫኑ፦`, 
            Markup.inlineKeyboard([
                [Markup.button.webApp("🎮 Play Dash Bingo", WEBAPP_URL)]
            ])
        );
    } catch (err) {
        console.error("Bot start error:", err);
    }
});

// ================= GAME ENGINE ================= //
const CARD_PRICE = 10; // 10 ETB
const HOUSE_COMMISSION = 0.20; // 20% House Rake

let gameState = {
    roundNumber: 1001,
    status: 'SELECTION',
    countdown: 50,
    selectedCards: {},
    calledNumbers: [],
    currentNumber: null,
    totalPrize: 0,
    ownerProfit: 0
};

function generateBingoCard() {
    const getCols = (min, max) => {
        let nums = [];
        while (nums.length < 5) {
            let r = Math.floor(Math.random() * (max - min + 1)) + min;
            if (!nums.includes(r)) nums.push(r);
        }
        return nums;
    };
    let b = getCols(1, 15);
    let i = getCols(16, 30);
    let n = getCols(31, 45);
    let g = getCols(46, 60);
    let o = getCols(61, 75);
    n[2] = 0; // Free Center Star
    return [b, i, n, g, o];
}

function checkWinner(card, called) {
    const isMarked = (val) => val === 0 || called.includes(val);
    for (let c = 0; c < 5; c++) {
        if (card[c].every(isMarked)) return true;
    }
    for (let r = 0; r < 5; r++) {
        let rowWin = true;
        for (let c = 0; c < 5; c++) {
            if (!isMarked(card[c][r])) { rowWin = false; break; }
        }
        if (rowWin) return true;
    }
    let diag1 = true, diag2 = true;
    for (let i = 0; i < 5; i++) {
        if (!isMarked(card[i][i])) diag1 = false;
        if (!isMarked(card[i][4 - i])) diag2 = false;
    }
    return diag1 || diag2;
}

// 🤖 የኮምፒውተር ቆራጮች (Simulated Bots) ተግባር
function simulateBotPurchases() {
    if (!ENABLE_SIMULATED_PLAYERS || gameState.status !== 'SELECTION') return;

    // በየዙሩ ከ 3 እስከ 6 ቦቶች በተለያየ ሰከንድ ይቆርጣሉ
    const botCount = Math.floor(Math.random() * 4) + 3;

    for (let i = 0; i < botCount; i++) {
        setTimeout(() => {
            if (gameState.status !== 'SELECTION') return;

            let randomCardIndex;
            let attempts = 0;
            do {
                randomCardIndex = Math.floor(Math.random() * 60) + 1;
                attempts++;
            } while (gameState.selectedCards[randomCardIndex] && attempts < 100);

            if (gameState.selectedCards[randomCardIndex]) return;

            const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
            const generatedCard = generateBingoCard();

            gameState.selectedCards[randomCardIndex] = {
                userId: null,
                userName: botName,
                numbers: generatedCard,
                isBot: true
            };

            const cardCount = Object.keys(gameState.selectedCards).length;
            const totalPot = cardCount * CARD_PRICE;
            gameState.totalPrize = totalPot * (1 - HOUSE_COMMISSION);

            io.emit('card_taken', {
                cardIndex: randomCardIndex,
                userName: botName,
                totalCards: cardCount,
                poolPrize: gameState.totalPrize
            });
        }, (i + 1) * 4500); // በየ 4.5 ሰከንዱ ረጋ ብለው ይቆርጣሉ
    }
}

// Game Loop Timer
setInterval(async () => {
    if (gameState.status === 'SELECTION') {
        gameState.countdown--;
        io.emit('game_tick', { status: 'SELECTION', countdown: gameState.countdown });

        if (gameState.countdown <= 0) {
            const cardCount = Object.keys(gameState.selectedCards).length;
            if (cardCount >= 1) {
                gameState.status = 'PLAYING';
                gameState.calledNumbers = [];
                const totalPot = cardCount * CARD_PRICE;
                gameState.ownerProfit = totalPot * HOUSE_COMMISSION;
                gameState.totalPrize = totalPot - gameState.ownerProfit;
                io.emit('round_started', gameState);
            } else {
                gameState.countdown = 50;
            }
        }
    } else if (gameState.status === 'PLAYING') {
        if (gameState.calledNumbers.length >= 75) {
            resetGame();
            return;
        }

        let nextNum;
        do {
            nextNum = Math.floor(Math.random() * 75) + 1;
        } while (gameState.calledNumbers.includes(nextNum));

        gameState.calledNumbers.push(nextNum);
        gameState.currentNumber = nextNum;

        let winners = [];
        for (const [cardIndex, cardData] of Object.entries(gameState.selectedCards)) {
            if (checkWinner(cardData.numbers, gameState.calledNumbers)) {
                winners.push({ cardIndex, ...cardData });
            }
        }

        if (winners.length > 0) {
            gameState.status = 'GAME_OVER';
            const splitPrize = gameState.totalPrize / winners.length;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const win of winners) {
                    // እውነተኛ ተጫዋች ከሆነ ብቻ ሒሳቡን ጨምር
                    if (!win.isBot && win.userId) {
                        await client.query(
                            `UPDATE users SET balance = balance + $1, total_won = total_won + $1 WHERE id = $2`,
                            [splitPrize, win.userId]
                        );
                    }
                }

                // ቦት ካሸነፈ winner_id NULL እንዲሆን በማድረግ የዳታቤዝ ስህተትን መከላከል
                const realWinnerId = winners[0].isBot ? null : winners[0].userId;

                await client.query(
                    `INSERT INTO bingo_rounds (round_number, card_price, total_cards, pool_prize, owner_rake, winner_id, winning_card_number)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [gameState.roundNumber, CARD_PRICE, Object.keys(gameState.selectedCards).length, gameState.totalPrize, gameState.ownerProfit, realWinnerId, winners[0].cardIndex]
                );
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error("Payout error:", err);
            } finally {
                client.release();
            }

            io.emit('round_won', { winners, prize: splitPrize, calledNumbers: gameState.calledNumbers });

            setTimeout(() => {
                resetGame();
            }, 6000);
        } else {
            io.emit('number_called', {
                number: nextNum,
                called: gameState.calledNumbers
            });
        }
    }
}, 2400);

function resetGame() {
    gameState.roundNumber++;
    gameState.status = 'SELECTION';
    gameState.countdown = 50;
    gameState.selectedCards = {};
    gameState.calledNumbers = [];
    gameState.currentNumber = null;
    gameState.totalPrize = 0;
    gameState.ownerProfit = 0;
    io.emit('game_reset', gameState);

    // 🤖 አዲሱ ዙር እንደጀመረ ቦቶች ካርድ እንዲቆርጡ መጥራት
    simulateBotPurchases();
}

// ሰርቨሩ ልክ ሲነሳ የመጀመሪያው ዙር ላይ ቦቶችን ማስጀመር
setTimeout(() => {
    simulateBotPurchases();
}, 2000);

// ================= REST APIS ================= //

app.post('/api/user/sync', async (req, res) => {
    const { telegramId, firstName, username } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId is required' });

    try {
        const { rows } = await pool.query(
            `INSERT INTO users (telegram_id, first_name, username) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (telegram_id) DO UPDATE 
             SET first_name = EXCLUDED.first_name, username = EXCLUDED.username 
             RETURNING *`,
            [telegramId, firstName || 'ተጫዋች', username || '']
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/claim-welcome', async (req, res) => {
    const { telegramId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT id, balance FROM users WHERE telegram_id = $1 FOR UPDATE', [telegramId]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
        }
        const user = userRes.rows[0];

        const checkBonus = await client.query(
            "SELECT id FROM transactions WHERE user_id = $1 AND type = 'WELCOME_BONUS'", 
            [user.id]
        );

        if (checkBonus.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ይቅርታ! የእንኳን ደህና መጡ ቦነስዎን ቀደም ሲል ወስደዋል!' });
        }

        await client.query('UPDATE users SET balance = balance + 20 WHERE id = $1', [user.id]);
        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, status) 
             VALUES ($1, 'WELCOME_BONUS', 'BONUS', 20.00, 'APPROVED')`,
            [user.id]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: '🎉 እንኳን ደስ አለዎት! የ 20 ብር ቦነስ ወደ ዋሌትዎ ገቢ ሆኗል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/deposit', async (req, res) => {
    const { telegramId, firstName, username, method, amount, smsText } = req.body;
    if (!amount || amount <= 0 || !smsText || smsText.trim().length < 15) {
        return res.status(400).json({ error: 'እባክዎ ትክክለኛ መጠንና ሙሉ የ SMS ጽሁፍ ያስገቡ!' });
    }

    const normalizedSMS = smsText.replace(/\s+/g, '').toLowerCase();
    const smsHash = crypto.createHash('sha256').update(normalizedSMS).digest('hex');

    try {
        const userRes = await pool.query(
            `INSERT INTO users (telegram_id, first_name, username) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (telegram_id) DO UPDATE SET first_name = EXCLUDED.first_name 
             RETURNING id`,
            [telegramId, firstName || 'ተጫዋች', username || '']
        );
        const userId = userRes.rows[0].id;

        await pool.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, sms_text, sms_hash, status) 
             VALUES ($1, 'DEPOSIT', $2, $3, $4, $5, 'PENDING')`,
            [userId, method, amount, smsText, smsHash]
        );
        res.json({ success: true, message: 'ማስገቢያ ጥያቄዎ ለአድሚን ተልኳል! ጥቂት ደቂቃ ይጠብቁ።' });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'ይህ SMS ቀደም ሲል ጥቅም ላይ ውሏል! አዲስ SMS ያስገቡ።' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/withdraw', async (req, res) => {
    const { telegramId, method, amount, accountNumber, accountName } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (isNaN(withdrawAmount) || withdrawAmount < 50) {
        return res.status(400).json({ error: 'ዝቅተኛው የማውጣት መጠን 50 ብር ነው!' });
    }
    if (!accountNumber || !accountName) {
        return res.status(400).json({ error: 'እባክዎ አካውንት እና ሙሉ ስም ያስገቡ!' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT id, balance FROM users WHERE telegram_id = $1 FOR UPDATE', [telegramId]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
        }

        const user = userRes.rows[0];
        if (parseFloat(user.balance) < withdrawAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'በቂ ሒሳብ የለዎትም!' });
        }

        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [withdrawAmount, user.id]);
        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, account_number, account_name, status) 
             VALUES ($1, 'WITHDRAW', $2, $3, $4, $5, 'PENDING')`,
            [user.id, method, withdrawAmount, accountNumber, accountName]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'የማውጣት ጥያቄዎ በተሳካ ሁኔታ ተመዝግቧል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/promocode/redeem', async (req, res) => {
    const { telegramId, code } = req.body;
    if (!code) return res.status(400).json({ error: 'እባክዎ ኮድ ያስገቡ!' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT id FROM users WHERE telegram_id = $1 FOR UPDATE', [telegramId]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
        }
        const userId = userRes.rows[0].id;

        const promoRes = await client.query('SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1) FOR UPDATE', [code.trim()]);
        if (promoRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'የተሳሳተ የፕሮሞ ኮድ!' });
        }
        const promo = promoRes.rows[0];

        if (promo.times_used >= promo.max_uses) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ይህ ፕሮሞ ኮድ ገደቡ አልቋል!' });
        }

        const claimCheck = await client.query('SELECT id FROM promo_claims WHERE user_id = $1 AND promo_id = $2', [userId, promo.id]);
        if (claimCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ይህን ፕሮሞ ኮድ ቀደም ሲል ወስደዋል!' });
        }

        await client.query('INSERT INTO promo_claims (user_id, promo_id) VALUES ($1, $2)', [userId, promo.id]);
        await client.query('UPDATE promo_codes SET times_used = times_used + 1 WHERE id = $1', [promo.id]);
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [promo.reward_amount, userId]);

        await client.query('COMMIT');
        res.json({ success: true, message: `እንኳን ደስ አለዎት! ${promo.reward_amount} ብር ወደ ዋሌትዎ ገቢ ሆኗል።` });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/weekly-top', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT first_name, username, cards_bought_this_week 
             FROM users 
             WHERE cards_bought_this_week > 0 
             ORDER BY cards_bought_this_week DESC LIMIT 10`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT first_name, username, total_won FROM users ORDER BY total_won DESC LIMIT 10');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history/:telegramId', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT t.* FROM transactions t 
             JOIN users u ON u.id = t.user_id 
             WHERE u.telegram_id = $1 ORDER BY t.created_at DESC LIMIT 20`,
            [req.params.telegramId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin APIs
app.get('/api/admin/transactions', checkAdminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT t.*, u.first_name, u.telegram_id FROM transactions t 
             JOIN users u ON u.id = t.user_id 
             ORDER BY t.created_at DESC LIMIT 50`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/approve', checkAdminAuth, async (req, res) => {
    const { txId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
        if (txRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ግብይቱ አልተገኘም' });
        }
        const tx = txRes.rows[0];
        if (tx.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ግብይቱ ቀደም ሲል ተጠናቋል' });
        }

        if (tx.type === 'DEPOSIT') {
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.amount, tx.user_id]);
        }

        await client.query("UPDATE transactions SET status = 'APPROVED' WHERE id = $1", [txId]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'ግብይቱ ጸድቋል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/admin/reject', checkAdminAuth, async (req, res) => {
    const { txId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
        const tx = txRes.rows[0];

        if (tx.type === 'WITHDRAW') {
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.amount, tx.user_id]);
        }

        await client.query("UPDATE transactions SET status = 'REJECTED' WHERE id = $1", [txId]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'ግብይቱ ውድቅ ተደርጓል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/admin/create-promocode', checkAdminAuth, async (req, res) => {
    const { code, amount, maxUses } = req.body;
    if (!code || !amount || !maxUses) return res.status(400).json({ error: 'ሁሉንም መረጃ ያስገቡ' });

    try {
        await pool.query(
            `INSERT INTO promo_codes (code, reward_amount, max_uses) VALUES ($1, $2, $3)`,
            [code.trim().toUpperCase(), amount, maxUses]
        );
        res.json({ success: true, message: 'አዲስ ፕሮሞ ኮድ ተፈጥሯል!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/distribute-weekly-bonus', checkAdminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, first_name, cards_bought_this_week 
             FROM users 
             WHERE cards_bought_this_week > 0 
             ORDER BY cards_bought_this_week DESC LIMIT 10`
        );

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ምንም ተጫዋች አልተገኘም' });
        }

        let distributed = [];
        for (let i = 0; i < rows.length; i++) {
            let bonus = 200;
            if (i === 0) bonus = 300;
            else if (i < 5) bonus = 250;

            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [bonus, rows[i].id]);
            distributed.push({ name: rows[i].first_name, bonus });
        }

        await client.query('UPDATE users SET cards_bought_this_week = 0');
        await client.query('COMMIT');
        res.json({ success: true, message: 'የሳምንቱ ቦነስ ለ 10 ሰዎች ተከፋፍሏል!', distributed });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/admin/analytics', checkAdminAuth, async (req, res) => {
    try {
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        const profit = await pool.query('SELECT SUM(owner_rake) as total_rake FROM bingo_rounds');
        const rounds = await pool.query('SELECT COUNT(*) FROM bingo_rounds');
        res.json({
            totalUsers: usersCount.rows[0].count,
            totalProfit: profit.rows[0].total_rake || 0,
            totalRounds: rounds.rows[0].count
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Socket.io Buy Card
io.on('connection', (socket) => {
    socket.emit('game_init', gameState);

    socket.on('buy_card', async ({ telegramId, cardIndex }) => {
        const cIndex = parseInt(cardIndex);
        if (isNaN(cIndex) || cIndex < 1 || cIndex > 999) {
            socket.emit('error_msg', 'የተሳሳተ የካርድ ቁጥር! (ከ 1 እስከ 999 ይምረጡ)');
            return;
        }

        if (gameState.status !== 'SELECTION') {
            socket.emit('error_msg', 'የካርድ መቁረጫ ሰዓቱ አልቋል!');
            return;
        }
        if (gameState.selectedCards[cIndex]) {
            socket.emit('error_msg', `ካርድ #${cIndex} ቀደም ሲል ተይዟል! እባክዎ ሌላ ይምረጡ።`);
            return;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query('SELECT id, first_name, balance FROM users WHERE telegram_id = $1 FOR UPDATE', [telegramId]);
            if (userRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return;
            }
            const user = userRes.rows[0];

            if (parseFloat(user.balance) < CARD_PRICE) {
                await client.query('ROLLBACK');
                socket.emit('error_msg', `ሒሳብዎ በቂ አይደለም! ካርድ ለመቁረጥ ቢያንስ ${CARD_PRICE} ETB ያስፈልጋል።`);
                return;
            }

            await client.query(
                `UPDATE users 
                 SET balance = balance - $1, cards_bought_this_week = cards_bought_this_week + 1 
                 WHERE id = $2`,
                [CARD_PRICE, user.id]
            );

            const generatedCard = generateBingoCard();
            gameState.selectedCards[cIndex] = {
                userId: user.id,
                userName: user.first_name,
                numbers: generatedCard,
                isBot: false
            };

            await client.query('COMMIT');

            const cardCount = Object.keys(gameState.selectedCards).length;
            const totalPot = cardCount * CARD_PRICE;
            gameState.totalPrize = totalPot * (1 - HOUSE_COMMISSION);

            io.emit('card_taken', {
                cardIndex: cIndex,
                userName: user.first_name,
                totalCards: cardCount,
                poolPrize: gameState.totalPrize
            });

            socket.emit('my_card', { cardIndex: cIndex, numbers: generatedCard });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error("Card purchase error:", e);
        } finally {
            client.release();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`⚡ Dash Bingo Server running on port ${PORT}`);
    bot.launch();
});
