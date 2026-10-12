require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

// Database Connection (Neon Postgres) with Auto-Reconnect Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 25,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
    console.error('Neon DB Pool Error:', err);
});

// Auto-run DB Migrations
(async () => {
    try {
        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN DEFAULT FALSE;
        `);
        console.log('✅ DB Schema verified successfully');
    } catch (e) {
        console.error('Migration notice:', e.message);
    }
})();

// Static Web Routes
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

// Telegram Bot Init
const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://dashbingo.onrender.com';
const CHANNEL_ID = '@DashBingo'; // 📢 አሸናፊዎችን ፖስት የሚያደርግበት ቻናል

// 📩 አስተማማኝ የቴሌግራም መልእክት መላኪያ
async function sendTelegramNotification(telegramId, message) {
    try {
        if (!telegramId) return;
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML' });
    } catch (err) {
        console.warn(`Telegram send warning (${telegramId}):`, err.message);
    }
}

// ================= 🟢🔴 AGENT STATUS ENGINE ================= //
let agentStatus = {
    cbe: { name: "Aymen Kemal", handle: "@Dashagent1", account: "1000562339427", isOnline: true },
    telebirr: { name: "Nebyu", handle: "@Dashagent1", account: "0968260447", isOnline: true }
};

// የኤጀንቶች የቀጥታ ሁኔታ መረጃ ለአፑ
app.get('/api/agents/status', (req, res) => {
    res.json(agentStatus);
});

// አድሚን ኤጀንቱን Online/Offline መቀየሪያ
app.post('/api/admin/agents/toggle', checkAdminAuth, (req, res) => {
    const { agent, isOnline } = req.body;
    if (agentStatus[agent]) {
        agentStatus[agent].isOnline = Boolean(isOnline);
        res.json({ success: true, agentStatus });
    } else {
        res.status(400).json({ error: 'Agent not found' });
    }
});

// Telegram Bot Start with Referral Tracking
bot.start(async (ctx) => {
    const { id, first_name, username } = ctx.from;
    const startPayload = ctx.startPayload || '';

    let referrerId = null;
    if (startPayload.startsWith('ref_')) {
        const parsed = parseInt(startPayload.replace('ref_', ''));
        if (!isNaN(parsed) && parsed !== id) {
            referrerId = parsed;
        }
    }

    try {
        await pool.query(
            `INSERT INTO users (telegram_id, first_name, username, referred_by) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (telegram_id) DO UPDATE 
             SET first_name = $2, username = $3`,
            [id, first_name || 'ተጫዋች', username || '', referrerId]
        );

        ctx.reply(
            `እንኳን ወደ <b>Dash Bingo ⚡</b> በደህና መጡ!\n\n🎁 <b>የ 20 ETB ነፃ ቦነስ</b> ተዘጋጅቶልዎታል። አሁኑኑ ከታች ያለውን ይጫኑና ይጀምሩ፦`, 
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.webApp("🎮 Play Dash Bingo", WEBAPP_URL)]
                ])
            }
        );
    } catch (err) {
        console.error("Bot start error:", err);
    }
});

// ================= BOT SIMULATION (ጠፍቷል - እውነተኛ ተጫዋቾች ስላሉ) ================= //
const ENABLE_SIMULATED_PLAYERS = false;

// ================= GAME ENGINE ================= //
const CARD_PRICE = 10; // 10 ETB
const HOUSE_COMMISSION = 0.20; // 20% House Rake
const SELECTION_SECONDS = 30; // ⚡ 30 ሰከንድ የካርድ መቁረጫ

let gameState = {
    roundNumber: 1001,
    status: 'SELECTION',
    countdown: SELECTION_SECONDS,
    selectedCards: {}, // { cardIndex: { userId, userName, numbers, isBot } }
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
    n[2] = 0; // Center Free Star (★)
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

// Master Real-Time Game Loop
setInterval(async () => {
    if (gameState.status === 'SELECTION') {
        gameState.countdown--;
        io.emit('game_tick', { status: 'SELECTION', countdown: gameState.countdown });

        if (gameState.countdown <= 0) {
            const cardCount = Object.keys(gameState.selectedCards).length;
            if (cardCount >= 1) { // ቢያንስ 1 ካርድ ሲቆረጥ ዙሩ ይጀምራል
                gameState.status = 'PLAYING';
                gameState.calledNumbers = [];
                const totalPot = cardCount * CARD_PRICE;
                gameState.ownerProfit = totalPot * HOUSE_COMMISSION;
                gameState.totalPrize = totalPot - gameState.ownerProfit;
                io.emit('round_started', {
                    roundNumber: gameState.roundNumber,
                    totalPrize: gameState.totalPrize,
                    totalCards: cardCount
                });
            } else {
                gameState.countdown = SELECTION_SECONDS;
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

        // አሸናፊዎችን ማጣራት
        let winners = [];
        for (const [cardIndex, cardData] of Object.entries(gameState.selectedCards)) {
            if (checkWinner(cardData.numbers, gameState.calledNumbers)) {
                winners.push({ cardIndex: parseInt(cardIndex), ...cardData });
            }
        }

        if (winners.length > 0) {
            gameState.status = 'GAME_OVER';
            const splitPrize = gameState.totalPrize / winners.length;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const win of winners) {
                    if (!win.isBot && win.userId) {
                        await client.query(
                            `UPDATE users SET balance = balance + $1, total_won = total_won + $1 WHERE id = $2`,
                            [splitPrize, win.userId]
                        );

                        const uRes = await client.query('SELECT telegram_id FROM users WHERE id = $1', [win.userId]);
                        if (uRes.rows.length > 0) {
                            sendTelegramNotification(
                                uRes.rows[0].telegram_id,
                                `🎉 <b>BINGO WINNER! እንኳን ደስ አለዎት!</b>\n\nበካርድ #${win.cardIndex} <b>${splitPrize.toFixed(2)} ETB</b> አሸንፈዋል! ገንዘቡ ወደ ዋሌትዎ ገቢ ሆኗል።`
                            );
                        }
                    }
                }

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

            const winnerSummary = winners.map(w => `${w.userName} (#${w.cardIndex})`).join(', ');

            try {
                await bot.telegram.sendMessage(
                    CHANNEL_ID,
                    `⚡ <b>ዙር #${gameState.roundNumber} ተጠናቋል!</b>\n\n🏆 <b>አሸናፊ፡</b> ${winnerSummary}\n💰 <b>ሽልማት፡</b> ${splitPrize.toFixed(2)} ETB\n\n👉 አሁኑኑ ገብተው ይጫወቱ፡ <a href="https://t.me/dashbingobot/eth">Dash Bingo ይጫወቱ</a>`,
                    { parse_mode: 'HTML', disable_web_page_preview: true }
                );
            } catch (err) {
                console.warn("Channel broadcast notice:", err.message);
            }

            io.emit('round_won', {
                winners: winners.map(w => ({ userName: w.userName, cardIndex: w.cardIndex })),
                prize: splitPrize,
                calledNumbers: gameState.calledNumbers
            });

            setTimeout(() => {
                resetGame();
            }, 3000);
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
    gameState.countdown = SELECTION_SECONDS;
    gameState.selectedCards = {};
    gameState.calledNumbers = [];
    gameState.currentNumber = null;
    gameState.totalPrize = 0;
    gameState.ownerProfit = 0;
    io.emit('game_reset', gameState);
}

// ================= REST APIS ================= //

// User Sync with Referral tracking
app.post('/api/user/sync', async (req, res) => {
    const { telegramId, firstName, username, ref } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId is required' });

    let referrerId = null;
    if (ref) {
        const parsed = parseInt(String(ref).replace('ref_', ''));
        if (!isNaN(parsed) && parsed !== parseInt(telegramId)) {
            referrerId = parsed;
        }
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO users (telegram_id, first_name, username, referred_by) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (telegram_id) DO UPDATE 
             SET first_name = EXCLUDED.first_name, username = EXCLUDED.username 
             RETURNING *`,
            [telegramId, firstName || 'ተጫዋች', username || '', referrerId]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/:telegramId', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [req.params.telegramId]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🎁 20 ETB Welcome Bonus Claim API
app.post('/api/user/claim-welcome', async (req, res) => {
    const { telegramId, firstName, username } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId is required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const userRes = await client.query(
            `INSERT INTO users (telegram_id, first_name, username) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (telegram_id) DO UPDATE SET first_name = EXCLUDED.first_name 
             RETURNING id, balance`,
            [telegramId, firstName || 'ተጫዋች', username || '']
        );
        const user = userRes.rows[0];

        const checkBonus = await client.query(
            "SELECT id FROM transactions WHERE user_id = $1 AND type = 'WELCOME_BONUS'", 
            [user.id]
        );

        if (checkBonus.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'የእንኳን ደህና መጡ ቦነስዎን ቀደም ሲል ወስደዋል!' });
        }

        const newBal = parseFloat(user.balance) + 20;
        await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBal, user.id]);
        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, status) 
             VALUES ($1, 'WELCOME_BONUS', 'BONUS', 20.00, 'APPROVED')`,
            [user.id]
        );

        await client.query('COMMIT');

        sendTelegramNotification(
            telegramId,
            `🎁 <b>የ 20 ETB ቦነስ ተሰጥቶዎታል!</b>\n\nእንኳን ወደ Dash Bingo በደህና መጡ! 2 ዙር በነፃ ይጫወቱ። መልካም እድል!`
        );

        res.json({ success: true, balance: newBal, message: '🎉 እንኳን ደስ አለዎት! የ 20 ብር ቦነስ ወደ ዋሌትዎ ገቢ ሆኗል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 📥 Smart Deposit SMS Verification (CBE: Aymen Kemal | Telebirr: Nebyu)
app.post('/api/deposit', async (req, res) => {
    const { telegramId, firstName, username, method, amount, smsText } = req.body;
    const depAmount = parseFloat(amount);

    if (isNaN(depAmount) || depAmount <= 0 || !smsText || smsText.trim().length < 20) {
        return res.status(400).json({ error: 'እባክዎ ትክክለኛ መጠንና ሙሉ የ SMS ጽሁፍ ያስገቡ!' });
    }

    const cleanSMS = smsText.toLowerCase();

    // 🔍 1. የ CBE SMS ማጣሪያ (Aymen Kemal)
    if (method === 'CBE') {
        const hasAymen = cleanSMS.includes('aymen kemal') || cleanSMS.includes('aymen kemal ali') || cleanSMS.includes('9427');
        if (!hasAymen) {
            return res.status(400).json({ 
                error: 'የተሳሳተ የ CBE SMS! የክፍያው ደረሰኝ ወደ Aymen Kemal መሆኑን ያረጋግጡ።' 
            });
        }
        const amountStr = depAmount.toFixed(0);
        if (!cleanSMS.includes(amountStr)) {
            return res.status(400).json({ 
                error: `የተሳሳተ መጠን! ያስገቡት መጠን (${depAmount} ETB) በ SMS ጽሁፉ ውስጥ አልተገኘም።` 
            });
        }
    }

    // 🔍 2. የ Telebirr SMS ማጣሪያ (Nebyu)
    if (method === 'TELEBIRR') {
        const hasNebyu = cleanSMS.includes('nebyu') || cleanSMS.includes('nebiyu') || cleanSMS.includes('0968260447') || cleanSMS.includes('60447');
        if (!hasNebyu) {
            return res.status(400).json({ 
                error: 'የተሳሳተ የ Telebirr SMS! የክፍያው ደረሰኝ ወደ Nebyu መሆኑን ያረጋግጡ።' 
            });
        }
        const amountStr = depAmount.toFixed(0);
        if (!cleanSMS.includes(amountStr)) {
            return res.status(400).json({ 
                error: `የተሳሳተ መጠን! ያስገቡት መጠን (${depAmount} ETB) በ SMS ጽሁፉ ውስጥ አልተገኘም።` 
            });
        }
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
            [userId, method, depAmount, smsText, smsHash]
        );

        sendTelegramNotification(
            telegramId,
            `📥 <b>የማስገቢያ ጥያቄ ደርሶናል</b>\n\nመጠን፡ <b>${depAmount.toFixed(2)} ETB</b> (${method})\nሁኔታ፡ ⏳ በማረጋገጥ ላይ...\n\nኤጀንቱ ሲያረጋግጥ ወዲያውኑ ገቢ ይሆናል።`
        );

        res.json({ success: true, message: 'የማስገቢያ ጥያቄዎ በትክክል ደርሶናል! ኤጀንቱ በ 5 ደቂቃ ውስጥ አረጋግጦ ገቢ ያደርግልዎታል።' });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'ይህ SMS ቀደም ሲል ጥቅም ላይ ውሏል! አዲስ የግብይት SMS ያስገቡ።' });
        }
        res.status(500).json({ error: err.message });
    }
});

// 🛡️ 10ሩን የጥበቃ ህጎች ያካተተ የተጠናከረ የገንዘብ ማውጫ API (Withdrawal API)
app.post('/api/withdraw', async (req, res) => {
    const { telegramId, method, amount, accountNumber, accountName } = req.body;
    const withdrawAmount = parseFloat(amount);

    // 🛡️ ህግ 2፡ አነስተኛ ማውጫ 100 ETB፣ ከፍተኛው 5,000 ETB
    if (isNaN(withdrawAmount) || withdrawAmount < 100) {
        return res.status(400).json({ error: 'አነስተኛው የማውጣት መጠን 100 ETB ነው!' });
    }
    if (withdrawAmount > 5000) {
        return res.status(400).json({ error: 'በአንድ ጊዜ የሚፈቀደው ከፍተኛው የማውጣት መጠን 5,000 ETB ነው!' });
    }
    if (!accountNumber || !accountName) {
        return res.status(400).json({ error: 'እባክዎ አካውንት እና ሙሉ ስም በትክክል ያስገቡ!' });
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

        // 🛡️ ህግ 1፡ የመጀመሪያ ዴፖዚት ግዴታ ማረጋገጫ (First Deposit Check)
        const depCheck = await client.query(
            "SELECT id FROM transactions WHERE user_id = $1 AND type = 'DEPOSIT' AND status = 'APPROVED'", 
            [user.id]
        );
        if (depCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'ገንዘብ ለማውጣት ቢያንስ 1 ጊዜ ተቀማጭ (Deposit) ማድረግ ግዴታ ነው!' 
            });
        }

        // 🛡️ ህግ 4፡ በቀን ቢበዛ 2 ጊዜ ብቻ ማውጣት ይቻላል
        const recentWithRes = await client.query(
            `SELECT id FROM transactions 
             WHERE user_id = $1 AND type = 'WITHDRAW' 
             AND created_at >= NOW() - INTERVAL '24 hours' 
             AND status IN ('PENDING', 'APPROVED')`,
            [user.id]
        );
        if (recentWithRes.rows.length >= 2) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'በ 24 ሰዓት ውስጥ ቢበዛ 2 ጊዜ ብቻ ማውጣት ይቻላል! እባክዎ ነገ ይሞክሩ።' });
        }

        // የሒሳብ በቂነት ማረጋገጫ
        if (parseFloat(user.balance) < withdrawAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'በቂ ሒሳብ የለዎትም!' });
        }

        // 🛡️ ህግ 3፡ 5% የአገልግሎት ክፍያ ስሌት
        const fee = withdrawAmount * 0.05;
        const netPayout = withdrawAmount - fee;

        // ከዋሌቱ ሙሉው መጠን ይቀነሳል
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [withdrawAmount, user.id]);

        // በዳታቤዝ ላይ የሚመዘገበው የሚላከው የተጣራው መጠን (netPayout) ነው
        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, account_number, account_name, status) 
             VALUES ($1, 'WITHDRAW', $2, $3, $4, $5, 'PENDING')`,
            [user.id, method, netPayout, accountNumber, accountName]
        );

        await client.query('COMMIT');

        sendTelegramNotification(
            telegramId,
            `📤 <b>የማውጣት ጥያቄ ደርሶናል</b>\n\nየተጠየቀው መጠን፡ <b>${withdrawAmount.toFixed(2)} ETB</b>\nየአገልግሎት ክፍያ (5%)፡ <b>${fee.toFixed(2)} ETB</b>\nየሚደርስዎት የተጣራ ብር፡ <b>${netPayout.toFixed(2)} ETB</b>\nወደ፡ <b>${accountNumber}</b> (${accountName})\n\nኤጀንቱ አረጋግጦ በቅርቡ ይልክልዎታል።`
        );

        res.json({ 
            success: true, 
            message: `የ ${withdrawAmount} ETB ማውጣት ጥያቄዎ ተመዝግቧል! (5% ክፍያ ተቀንሶ ${netPayout.toFixed(2)} ETB ይላክልዎታል)` 
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Promo Code Redeem
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

// Leaderboard & Weekly Top
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
             WHERE u.telegram_id = $1 ORDER BY t.created_at DESC LIMIT 30`,
            [req.params.telegramId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= 📊 ALL-TIME & TIMEFRAME-BASED FINANCIAL AUDIT API ================= //
// ድጋፍ የሚሰጣቸው የጊዜ ገደቦች፡ 1h, 12h, 24h, 7d, 15d, 30d, all
app.get('/api/admin/audit', checkAdminAuth, async (req, res) => {
    const timeframe = req.query.timeframe || 'all';

    let timeFilterTx = "";
    let timeFilterRounds = "";
    let timeFilterUsers = "";

    switch (timeframe) {
        case '1h':
            timeFilterTx = "AND created_at >= NOW() - INTERVAL '1 hour'";
            timeFilterRounds = "WHERE created_at >= NOW() - INTERVAL '1 hour'";
            timeFilterUsers = "WHERE created_at >= NOW() - INTERVAL '1 hour'";
            break;
        case '12h':
            timeFilterTx = "AND created_at >= NOW() - INTERVAL '12 hours'";
            timeFilterRounds = "WHERE created_at >= NOW() - INTERVAL '12 hours'";
            timeFilterUsers = "WHERE created_at >= NOW() - INTERVAL '12 hours'";
            break;
        case '24h':
            timeFilterTx = "AND created_at >= NOW() - INTERVAL '24 hours'";
            timeFilterRounds = "WHERE created_at >= NOW() - INTERVAL '24 hours'";
            timeFilterUsers = "WHERE created_at >= NOW() - INTERVAL '24 hours'";
            break;
        case '7d':
            timeFilterTx = "AND created_at >= NOW() - INTERVAL '7 days'";
            timeFilterRounds = "WHERE created_at >= NOW() - INTERVAL '7 days'";
            timeFilterUsers = "WHERE created_at >= NOW() - INTERVAL '7 days'";
            break;
        case '15d':
            timeFilterTx = "AND created_at >= NOW() - INTERVAL '15 days'";
            timeFilterRounds = "WHERE created_at >= NOW() - INTERVAL '15 days'";
            timeFilterUsers = "WHERE created_at >= NOW() - INTERVAL '15 days'";
            break;
        case '30d':
            timeFilterTx = "AND created_at >= NOW() - INTERVAL '30 days'";
            timeFilterRounds = "WHERE created_at >= NOW() - INTERVAL '30 days'";
            timeFilterUsers = "WHERE created_at >= NOW() - INTERVAL '30 days'";
            break;
        default: // 'all'
            timeFilterTx = "";
            timeFilterRounds = "";
            timeFilterUsers = "";
            break;
    }

    try {
        const auditQuery = `
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'APPROVED' AND payment_method = 'CBE' THEN amount ELSE 0 END), 0) AS cbe_deposits,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'APPROVED' AND payment_method = 'TELEBIRR' THEN amount ELSE 0 END), 0) AS telebirr_deposits,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'APPROVED' AND payment_method = 'CBE' THEN amount ELSE 0 END), 0) AS cbe_withdrawals,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'APPROVED' AND payment_method = 'TELEBIRR' THEN amount ELSE 0 END), 0) AS telebirr_withdrawals,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS total_withdrawals,
                COALESCE(SUM(CASE WHEN type = 'WELCOME_BONUS' THEN amount ELSE 0 END), 0) AS welcome_bonus,
                COALESCE(SUM(CASE WHEN type = 'REFERRAL_BONUS' THEN amount ELSE 0 END), 0) AS referral_bonus,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_deposits_count,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_withdrawals_count
            FROM transactions
            WHERE 1=1 ${timeFilterTx};
        `;
        const { rows } = await pool.query(auditQuery);
        const data = rows[0];

        // የተጠቃሚዎች እና የዙር መረጃዎች
        const userBalRes = await pool.query('SELECT COALESCE(SUM(balance), 0) AS total_user_balance, COUNT(*) AS total_users FROM users');
        const periodUsersRes = await pool.query(`SELECT COUNT(*) AS period_users FROM users ${timeFilterUsers}`);
        const roundRes = await pool.query(`SELECT COALESCE(SUM(owner_rake), 0) AS total_rake, COUNT(*) AS round_count FROM bingo_rounds ${timeFilterRounds}`);

        res.json({
            timeframe,
            cbeDeposits: parseFloat(data.cbe_deposits),
            telebirrDeposits: parseFloat(data.telebirr_deposits),
            totalDeposits: parseFloat(data.cbe_deposits) + parseFloat(data.telebirr_deposits),
            cbeWithdrawals: parseFloat(data.cbe_withdrawals),
            telebirrWithdrawals: parseFloat(data.telebirr_withdrawals),
            totalWithdrawals: parseFloat(data.total_withdrawals),
            welcomeBonus: parseFloat(data.welcome_bonus),
            referralBonus: parseFloat(data.referral_bonus),
            totalBonus: parseFloat(data.welcome_bonus) + parseFloat(data.referral_bonus),
            pendingDepositsCount: parseInt(data.pending_deposits_count),
            pendingWithdrawalsCount: parseInt(data.pending_withdrawals_count),
            totalUserLiability: parseFloat(userBalRes.rows[0].total_user_balance),
            totalUsersAllTime: parseInt(userBalRes.rows[0].total_users),
            usersInPeriod: parseInt(periodUsersRes.rows[0].period_users),
            totalRake: parseFloat(roundRes.rows[0].total_rake),
            totalRounds: parseInt(roundRes.rows[0].round_count),
            agentStatus
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ⚡ በዳታቤዝ ደረጃ ተጠባባቂዎችን፣ ገቢዎችን እና ወጪዎችን ብቻ ለይቶ የሚያመጣ API
app.get('/api/admin/transactions', checkAdminAuth, async (req, res) => {
    const { category, timeframe } = req.query;

    // ቦነሶችን አውጥቶ እውነተኛ የሰው ገቢና ወጪዎችን ብቻ ማጣሪያ
    let conditions = ["t.type IN ('DEPOSIT', 'WITHDRAW')"];

    if (category === 'PENDING') {
        conditions.push("t.status = 'PENDING'");
    } else if (category === 'DEPOSIT') {
        conditions.push("t.type = 'DEPOSIT'");
    } else if (category === 'WITHDRAW') {
        conditions.push("t.type = 'WITHDRAW'");
    } else if (category === 'APPROVED') {
        conditions.push("t.status = 'APPROVED'");
    } else if (category === 'REJECTED') {
        conditions.push("t.status = 'REJECTED'");
    }

    // የጊዜ ማጣሪያ
    if (timeframe && timeframe !== 'all') {
        const intervals = {
            '30m': '30 minutes',
            '1h': '1 hour',
            '12h': '12 hours',
            '24h': '24 hours',
            '7d': '7 days',
            '15d': '15 days',
            '30d': '30 days'
        };
        if (intervals[timeframe]) {
            conditions.push(`t.created_at >= NOW() - INTERVAL '${intervals[timeframe]}'`);
        }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    try {
        const query = `
            SELECT t.*, u.first_name, u.telegram_id 
            FROM transactions t 
            LEFT JOIN users u ON u.id = t.user_id 
            ${whereClause}
            ORDER BY t.created_at DESC 
            LIMIT 300
        `;
        const { rows } = await pool.query(query);
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
        const txRes = await client.query(
            `SELECT t.*, u.telegram_id FROM transactions t 
             JOIN users u ON u.id = t.user_id 
             WHERE t.id = $1 FOR UPDATE`, 
            [txId]
        );
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

        if (tx.type === 'DEPOSIT') {
            sendTelegramNotification(
                tx.telegram_id,
                `✅ <b>ዴፖዚትዎ ጸድቋል!</b>\n\nየ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b> ክፍያዎ በኤጀንቱ ተረጋግጦ ወደ ዋሌትዎ ገቢ ሆኗል። አሁኑኑ ገብተው ይጫወቱ!`
            );
        } else {
            sendTelegramNotification(
                tx.telegram_id,
                `✅ <b>የማውጣት ጥያቄዎ ተፈጽሟል!</b>\n\nየ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b> የተጣራ ክፍያ ወደ <b>${tx.account_number}</b> ተልኮልዎታል። እናመሰግናለን!`
            );
        }

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
        const txRes = await client.query(
            `SELECT t.*, u.telegram_id FROM transactions t 
             JOIN users u ON u.id = t.user_id 
             WHERE t.id = $1 FOR UPDATE`, 
            [txId]
        );
        const tx = txRes.rows[0];

        if (tx.type === 'WITHDRAW') {
            // በዊዝድሮው የተያዘውን ብር ወደ ተጠቃሚው ዋሌት መመለስ (የተቀነሰው 5% ክፍያ ጨምሮ ሙሉው ይመለሳል)
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.amount, tx.user_id]);
        }

        await client.query("UPDATE transactions SET status = 'REJECTED' WHERE id = $1", [txId]);
        await client.query('COMMIT');

        sendTelegramNotification(
            tx.telegram_id,
            `🔄 <b>ውድ የ Dash Bingo ተጫዋች፦</b>\n\nበአዲሱ የኤጀንት አሰራር ስርዓታችን መሰረት የጠየቁት የ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b> ማውጣት ጥያቄ ወደ Bingo Walletዎ በሰላም ተመልሷል! ✅\n\nቻናላችን ላይ በተገለጸው መሰረት አዲሱን የኤጀንት አሰራር ይፋ ስናደርግ በቀጥታ ማውጣት ይችላሉ።\n\nትብብርዎን ከልብ እናመሰግናለን! 🙏⚡\n@DashBingo`
        );

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
            `SELECT id, first_name, telegram_id, cards_bought_this_week 
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

            sendTelegramNotification(
                rows[i].telegram_id,
                `🏆 <b>እንኳን ደስ አለዎት! የሳምንቱ ምርጥ ተጫዋች ሽልማት!</b>\n\nበሳምንቱ ከፍተኛ ካርድ በመቁረጥዎ የ <b>${bonus} ETB</b> ቦነስ አሸንፈዋል!`
            );
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

app.post('/api/admin/broadcast', checkAdminAuth, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    try {
        const { rows } = await pool.query('SELECT telegram_id FROM users');
        let sentCount = 0;

        for (const user of rows) {
            try {
                await bot.telegram.sendMessage(user.telegram_id, message, { parse_mode: 'HTML' });
                sentCount++;
                await new Promise(r => setTimeout(r, 45));
            } catch (err) {}
        }

        res.json({ success: true, message: `መልእክቱ ለ ${sentCount} ተጫዋቾች ተልኳል!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= SOCKET.IO: BUY CARD & QUALIFIED REFERRAL ================= //
io.on('connection', (socket) => {
    socket.emit('game_init', {
        roundNumber: gameState.roundNumber,
        status: gameState.status,
        countdown: gameState.countdown,
        calledNumbers: gameState.calledNumbers,
        currentNumber: gameState.currentNumber,
        totalPrize: gameState.totalPrize,
        totalCards: Object.keys(gameState.selectedCards).length,
        selectedCards: Object.keys(gameState.selectedCards).map(Number)
    });

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
            const userRes = await client.query(
                `SELECT id, first_name, balance, referred_by, referral_rewarded 
                 FROM users WHERE telegram_id = $1 FOR UPDATE`, 
                [telegramId]
            );
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

            // የካርድ ሂሳብ መቀነስ
            await client.query(
                `UPDATE users 
                 SET balance = balance - $1, cards_bought_this_week = cards_bought_this_week + 1 
                 WHERE id = $2`,
                [CARD_PRICE, user.id]
            );

            // 🛡️ ህግ 6፡ የተረጋገጠ ሪፈራል ብቻ (ተጫዋቹ እውነተኛ ዴፖዚት ካለው ብቻ 10 ETB መስጠት)
            if (user.referred_by && !user.referral_rewarded) {
                const userApprovedDep = await client.query(
                    "SELECT id FROM transactions WHERE user_id = $1 AND type = 'DEPOSIT' AND status = 'APPROVED' LIMIT 1",
                    [user.id]
                );

                if (userApprovedDep.rows.length > 0) {
                    await client.query(
                        `UPDATE users SET balance = balance + 10 WHERE telegram_id = $1`,
                        [user.referred_by]
                    );
                    await client.query(
                        `UPDATE users SET referral_rewarded = TRUE WHERE id = $1`,
                        [user.id]
                    );
                    await client.query(
                        `INSERT INTO transactions (user_id, type, payment_method, amount, status) 
                         SELECT id, 'REFERRAL_BONUS', 'BONUS', 10.00, 'APPROVED' 
                         FROM users WHERE telegram_id = $1`,
                        [user.referred_by]
                    );

                    sendTelegramNotification(
                        user.referred_by,
                        `🎉 <b>የ 10 ETB ሪፈራል ቦነስ አግኝተዋል!</b>\n\nየጋበዙት ተጫዋች (${user.first_name}) ዴፖዚት አድርጎ ጨዋታ ስለጀመረ 10 ETB ወደ ዋሌትዎ ገቢ ሆኗል!`
                    );
                }
            }

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
            gameState.ownerProfit = totalPot * HOUSE_COMMISSION;

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
server.listen(PORT, async () => {
    console.log(`⚡ Dash Bingo Ultra-Server running on port ${PORT}`);
    
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (e) {}

    bot.launch({ dropPendingUpdates: true })
        .then(() => console.log('🤖 Telegram Bot polling started successfully'))
        .catch(err => {
            console.warn('⚠️ Telegram Bot Launch Notice (Conflict bypassed):', err.message);
            console.log('💡 Dash Bingo Game & Web Server are live and running smoothly!');
        });
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
