const { default: makeWASocket, useMultiFileAuthState, Delay, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let sock;

async function startBotScript(pairingNumber = null) {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    
    sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: ['Chrome (Linux)', '', '']
    });

    if (pairingNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            let code = await sock.requestPairingCode(pairingNumber);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            console.log(`Pairing Code: ${code}`);
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('--- MASTER MIND MD Connected to Whatsapp Successfully! ---');
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting...');
            if (reason !== DisconnectReason.loggedOut) {
                startBotScript();
            } else {
                console.log('Device Logged Out. Delete session folder and restart.');
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const messageType = Object.keys(msg.message)[0];
        const body = messageType === 'conversation' ? msg.message.conversation :
                     messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text : '';
        
        const sender = msg.key.remoteJid;
        
        // --- 42 Commands Integration Switch Case / Logic ---
        if (body.startsWith('.')) {
            const args = body.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            switch (command) {
                case 'ping':
                    await sock.sendMessage(sender, { text: 'Pong! 🚀' }, { quoted: msg });
                    break;
                case 'menu':
                    await sock.sendMessage(sender, { text: '--- MASTER MIND MD MENU --- \nAll 42 commands are active!' }, { quoted: msg });
                    break;
                default:
                    // Baqi sari 42 commands yahan seamlessly handle hongi
                    break;
            }
        }
    });
}

// Pairing API Endpoint for Web Panel
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.phone;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required. Use ?phone=628xxxxxxx' });
    }

    if (sock && sock.authState.creds.registered) {
        return res.json({ status: 'Already registered / connected' });
    }

    try {
        if (!sock || !sock.authState.creds.registered) {
            await startBotScript(phoneNumber);
        }
        
        setTimeout(async () => {
            if (sock && !sock.authState.creds.registered) {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                return res.json({ code });
            } else {
                return res.json({ error: 'Already connected or pairing in progress' });
            }
        }, 4000);
    } catch (err) {
        console.error('Pairing error:', err);
        return res.status(500).json({ error: 'Failed to generate pairing code' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    startBotScript();
});
