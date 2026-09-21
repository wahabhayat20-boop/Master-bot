const express = require('express');
const path = require('path');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let Sock;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    
    Sock = makeWASocket({
        auth: makeCacheableSignalKeyStore(state, pino({ level: 'silent' })),
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    Sock.ev.on('creds.update', saveCreds);

    Sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // Bot Command: .menu
        if (body.toLowerCase() === '.menu' || body.toLowerCase() === 'menu') {
            const menuText = `╭━━━〔 🔥 𝙈𝘼𝙎𝙏𝙀𝙍 𝙈𝙄𝙉𝘿 𝙈𝘿 🔥 〕━━━╮
┃ 
┃ ⚙️ Prefix : [ . ]
┃ 👤 Owner  : MASTER MIND
┃ ⚡ Speed  : 0.02s
┃
┣━━━⪧ ⚙️ 𝘼𝙐𝙏𝙊 𝙎𝙀𝙏𝙏𝙄𝙉𝙂𝙎
┃
┃ ◈ .autoreact on/off
┃ ◈ .autostatusview on/off
┃ ◈ .autostatuslike on/off
┃
┣━━━⪧ 👥 𝙂𝙍𝙊𝙐𝙋 𝘾𝙊𝙉𝙏𝙍𝙊𝙇
┃ 
┃ ◈ .tagall
┃ ◈ .hidetag
┃ ◈ .adminlist
┃ ◈ .groupinfo
┃ ◈ .kick
┃ ◈ .add
┃ ◈ .p
┃ ◈ .d
┃ ◈ .group open/close
┃ ◈ .link
┃ ◈ .revoke
┃ ◈ .setname
┃ ◈ .setdesc
┃ ◈ .mute / .unmute
┃ ◈ .antilink on/off
┃ ◈ .antistatus on/off
┃ ◈ .antispam on/off
┃ ◈ .antibot on/off
┃ ◈ .antiword on/off
┃ ◈ .antidelete on/off
┃ ◈ .warn
┃ ◈ .unwarn
┃ ◈ .resetlink
┃ ◈ .poll
┃ ◈ .del
┃
┣━━━⪧ 🕵️ 𝙎𝙀𝘾𝙍𝙀𝙏 & 𝙎𝙏𝘼𝙏𝙐𝙎 𝙏𝙊𝙊𝙇𝙎
┃
┃ ◈ .vv
┃ ◈ .save
┃ ◈ .status
┃
┣━━━⪧ 🔄 𝙈𝙀𝘿𝙄𝘼 𝘾𝙊𝙉𝙑𝙀𝙍𝙏𝙀𝙍𝙎
┃
┃ ◈ .s / .sticker
┃ ◈ .toimg / .toimage
┃ ◈ .tomp3 / .tovoice
┃ ◈ .tourl
┃
┣━━━⪧ 📥 𝘿𝙊𝙒𝙉𝙇𝙊𝘼𝘿𝙀𝙍
┃
┃ ◈ .play
┃ ◈ .song
┃ ◈ .video
┃ ◈ .ytmp4
┃ ◈ .ig / .instagram
┃ ◈ .fb / .facebook
┃ ◈ .tiktok
┃
┣━━━⪧ 🤖 𝘼𝙄 𝘾𝙃𝘼𝙏
┃
┃ ◈ .ai
┃ ◈ .gpt
┃
┣━━━⪧ 🛠️ 𝙐𝙏𝙄𝙇𝙄𝙏𝙄𝙀𝙎 & 𝙎𝙔𝙎𝙏𝙀𝙈
┃
┃ ◈ .google
┃ ◈ .weather
┃ ◈ .ping / .speed
┃ ◈ .runtime / .uptime
┃ ◈ .clearcache
┃ ◈ .id
┃ ◈ .sc
┃
┣━━━⪧ 👑 𝙊𝙒𝙉𝙀𝙍 𝙊𝙉𝙇𝙔
┃
┃ ◈ .public
┃ ◈ .private
┃ ◈ .restart
┃ ◈ .ban
┃ ◈ .unban
┃ ◈ .setprefix
┃ ◈ .block
┃ ◈ .unblock
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;

            await Sock.sendMessage(from, {
                image: { url: "https://cdn.phototourl.com/free/2026-09-20-69beb658-b75d-4cd8-a291-0f3656dfcb02.jpg" },
                caption: menuText
            });
        }

        if (body.toLowerCase() === '.ping' || body.toLowerCase() === '.speed') {
            await Sock.sendMessage(from, { text: '⚡ *Pong! Speed: 0.02s*' });
        }
    });
}

// Pairing Endpoint
app.get('/pair', async (req, res) => {
    let phone = req.query.number;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    try {
        if (!Sock) await startBot();
        phone = phone.replace(/[^0-9]/g, '');
        let code = await Sock.requestPairingCode(phone);
        res.json({ code: code });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to generate pairing code' });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    startBot();
});
      
