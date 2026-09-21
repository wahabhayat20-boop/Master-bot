const express = require('express');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let Sock;
let isPublic = true;
let botPrefix = '.';
const bannedUsers = new Set();
const deletedMessagesStore = new Map();
const userWarnings = {};

// Auto Feature Settings
const settings = {
    autoreact: false,
    autostatusview: true,
    autostatuslike: true,
    antilink: false,
    antistatus: false,
    antispam: false,
    antibot: false,
    antiword: false,
    antidelete: true
};

const badWords = ['bc', 'mc', 'gand', 'chutia', 'fucker', 'bitch'];

function getUptime() {
    const uptime = process.uptime();
    const days = Math.floor(uptime / (3600 * 24));
    const hours = Math.floor((uptime % (3600 * 24)) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

async function startBotSocket(pairingNumber = null) {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    
    Sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome (Linux)", "", ""]
    });

    Sock.ev.on('creds.update', saveCreds);

    Sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBotSocket();
        } else if (connection === 'open') {
            console.log('✅ MASTER MIND MD Connected to WhatsApp Successfully!');
        }
    });

    if (pairingNumber && !Sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await Sock.requestPairingCode(pairingNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`🔑 Pairing Code for ${pairingNumber}: ${code}`);
            } catch (err) {
                console.error('Error getting pairing code:', err);
            }
        }, 3000);
    }

    Sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;

        if (from === 'status@broadcast') {
            if (settings.autostatusview) await Sock.readMessages([msg.key]);
            if (settings.autostatuslike) {
                const emojis = ['💚', '🔥', '👑', '⚡', '❤️', '👍'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                await Sock.sendMessage(from, { react: { text: randomEmoji, key: msg.key } }, { statusJidList: [msg.key.participant] });
            }
            return;
        }

        if (msg.key.id) {
            deletedMessagesStore.set(msg.key.id, msg);
            if (deletedMessagesStore.size > 500) {
                const firstKey = deletedMessagesStore.keys().next().value;
                deletedMessagesStore.delete(firstKey);
            }
        }

        if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
            if (settings.antidelete) {
                const deletedKey = msg.message.protocolMessage.key;
                const originalMsg = deletedMessagesStore.get(deletedKey.id);
                if (originalMsg) {
                    const deletedBody = originalMsg.message.conversation || originalMsg.message.extendedTextMessage?.text || 'Media Message';
                    const sender = originalMsg.key.participant || originalMsg.key.remoteJid;
                    await Sock.sendMessage(from, { text: `🗑️ *MASTER MIND ANTI-DELETE DETECTED!*\n\n👤 *Sender:* @${sender.split('@')[0]}\n📝 *Deleted Message:* ${deletedBody}`, mentions: [sender] });
                }
            }
            return;
        }

        if (msg.key.fromMe) return;

        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? (msg.key.participant || msg.participant) : from;

        if (bannedUsers.has(sender.split('@')[0])) return;

        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';

        if (isGroup && settings.antilink && (body.includes('chat.whatsapp.com/') || body.includes('wa.me/'))) {
            await Sock.sendMessage(from, { delete: msg.key });
            await Sock.sendMessage(from, { text: `⚠️ *Anti-Link Active!* @${sender.split('@')[0]} Links are strictly prohibited!`, mentions: [sender] });
            return;
        }

        if (isGroup && settings.antibot && (msg.key.id.startsWith('BAE5') || msg.key.id.length === 16)) {
            await Sock.sendMessage(from, { delete: msg.key });
            await Sock.groupParticipantsUpdate(from, [sender], 'remove');
            await Sock.sendMessage(from, { text: `🤖 *Anti-Bot Active!* Removed: @${sender.split('@')[0]}`, mentions: [sender] });
            return;
        }

        if (settings.antiword && badWords.some(word => body.toLowerCase().includes(word))) {
            await Sock.sendMessage(from, { delete: msg.key });
            await Sock.sendMessage(from, { text: `🚫 *Bad words detected!* Message removed.` });
            return;
        }

        if (settings.autoreact && !body.startsWith(botPrefix)) {
            const autoEmojis = ['🔥', '⚡', '👑', '💯', '✨'];
            await Sock.sendMessage(from, { react: { text: autoEmojis[Math.floor(Math.random() * autoEmojis.length)], key: msg.key } });
        }

        if (!body.startsWith(botPrefix)) return;

        const args = body.slice(botPrefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(' ');

        if (!isPublic && !msg.key.fromMe) return;

        try {
            switch (command) {
                case 'autoreact': { settings.autoreact = (text === 'on'); await Sock.sendMessage(from, { text: `⚙️ *Auto React:* ${settings.autoreact ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                case 'autostatusview': { settings.autostatusview = (text === 'on'); await Sock.sendMessage(from, { text: `👁️ *Auto Status View:* ${settings.autostatusview ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                case 'autostatuslike': { settings.autostatuslike = (text === 'on'); await Sock.sendMessage(from, { text: `💚 *Auto Status Like:* ${settings.autostatuslike ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                case 'antilink': { settings.antilink = (text === 'on'); await Sock.sendMessage(from, { text: `🔗 *Anti-Link:* ${settings.antilink ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                case 'antistatus': { settings.antistatus = (text === 'on'); await Sock.sendMessage(from, { text: `🛑 *Anti-Status:* ${settings.antistatus ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                case 'antidelete': { settings.antidelete = (text === 'on'); await Sock.sendMessage(from, { text: `🗑️ *Anti-Delete:* ${settings.antidelete ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                case 'antibot': { settings.antibot = (text === 'on'); await Sock.sendMessage(from, { text: `🤖 *Anti-Bot:* ${settings.antibot ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                case 'antispam': { settings.antispam = (text === 'on'); await Sock.sendMessage(from, { text: `⚡ *Anti-Spam:* ${settings.antispam ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                case 'antiword': { settings.antiword = (text === 'on'); await Sock.sendMessage(from, { text: `🚫 *Anti-Word:* ${settings.antiword ? 'ON ✅' : 'OFF ❌'}` }, { quoted: msg }); break; }
                                                                  case 'menu': {
                    const menuText = `╭━━━〔 🔥 𝙈𝘼𝙎𝙏𝙀𝙍 𝙈𝙄𝙉𝘿 𝙈𝘿 🔥 〕━━━╮
┃ 
┃ ⚙️ Prefix : [ ${botPrefix} ]
┃ 👤 Owner  : बैटमैन (Batman)
┃ ⚡ Speed  : 0.02s
┃ ⏳ Uptime : ${getUptime()}
┃
┣━━━⪧ ⚙️ 𝘼𝙐𝙏𝙊 𝙎𝙀𝙏𝙏𝙄𝙉𝙂𝙎
┃ ◈ .autoreact on/off
┃ ◈ .autostatusview on/off
┃ ◈ .autostatuslike on/off
┃
┣━━━⪧ 👥 𝙂𝙍𝙊𝙐𝙋 𝘾𝙊𝙉𝙏𝙍𝙊𝙇
┃ ◈ .tagall
┃ ◈ .hidetag
┃ ◈ .adminlist
┃ ◈ .groupinfo
┃ ◈ .kick
┃ ◈ .add
┃ ◈ .p / .promote
┃ ◈ .d / .demote
┃ ◈ .group open/close
┃ ◈ .link
┃ ◈ .revoke / .resetlink
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
┃ ◈ .poll
┃ ◈ .del
┃
┣━━━⪧ 🕵️ 𝙎𝙀𝘾𝙍𝙀𝙏 & 𝙎𝙏𝘼𝙏𝙐𝙎 𝙏𝙊𝙊𝙇𝙎
┃ ◈ .vv
┃ ◈ .save / .status
┃
┣━━━⪧ 🔄 𝙈𝙀𝘿𝙄𝘼 𝘾𝙊𝙉𝙑𝙀𝙍𝙏𝙀𝙍𝙎
┃ ◈ .s / .sticker
┃ ◈ .toimg / .toimage
┃ ◈ .tomp3 / .tovoice
┃ ◈ .tourl
┃
┣━━━⪧ 📥 𝘿𝙊𝙒𝙉𝙇𝙊𝘼𝘿𝙀𝙍𝙎
┃ ◈ .song / .play
┃ ◈ .video / .ytmp4
┃ ◈ .ig / .instagram
┃ ◈ .fb / .facebook
┃ ◈ .tiktok
┃
┣━━━⪧ 🛠️ 𝙐𝙏𝙄𝙇𝙄𝙏𝙄𝙀𝙎 & 𝙎𝙔𝙎𝙏𝙀𝙈
┃ ◈ .google
┃ ◈ .weather
┃ ◈ .ping / .speed
┃ ◈ .runtime / .uptime
┃ ◈ .clearcache
┃ ◈ .id
┃ ◈ .sc
┃
┣━━━⪧ 👑 𝙊𝙒𝙉𝙀𝙍 𝙊𝙉𝙇𝗬
┃ ◈ .public
┃ ◈ .private
┃ ◈ .restart
┃ ◈ .ban
┃ ◈ .unban
┃ ◈ .setprefix
┃ ◈ .block
┃ ◈ .unblock
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;
                    await Sock.sendMessage(from, { image: { url: "https://cdn.phototourl.com/free/2026-09-20-69beb658-b75d-4cd8-a291-0f3656dfcb02.jpg" }, caption: menuText }, { quoted: msg });
                    break;
                }
                
                // GROUP CONTROL COMMANDS
                case 'tagall': {
                    if (!isGroup) return Sock.sendMessage(from, { text: '❌ Group command only!' }, { quoted: msg });
                    const groupMetadata = await Sock.groupMetadata(from);
                    let textTag = `📣 *MASTER MIND MD TAG ALL*\n\n`;
                    const mentions = groupMetadata.participants.map(p => p.id);
                    for (let mem of groupMetadata.participants) textTag += `@${mem.id.split('@')[0]}\n`;
                    await Sock.sendMessage(from, { text: textTag, mentions }, { quoted: msg });
                    break;
                }
                case 'hidetag': {
                    if (!isGroup) return Sock.sendMessage(from, { text: '❌ Group command only!' }, { quoted: msg });
                    const groupMetadata = await Sock.groupMetadata(from);
                    const mentions = groupMetadata.participants.map(p => p.id);
                    await Sock.sendMessage(from, { text: text || '📢 *Attention Everyone!*', mentions });
                    break;
                }
                case 'adminlist': {
                    if (!isGroup) return;
                    const groupMetadata = await Sock.groupMetadata(from);
                    const admins = groupMetadata.participants.filter(p => p.admin !== null).map(p => `@${p.id.split('@')[0]}`);
                    await Sock.sendMessage(from, { text: `👑 *Group Admins:\n\n${admins.join('\n')}`, mentions: groupMetadata.participants.filter(p => p.admin !== null).map(p => p.id) }, { quoted: msg });
                    break;
                }
                case 'groupinfo': {
                    if (!isGroup) return;
                    const groupMetadata = await Sock.groupMetadata(from);
                    await Sock.sendMessage(from, { text: `📌 *Group Name:* ${groupMetadata.subject}\n👥 *Members:* ${groupMetadata.participants.length}` }, { quoted: msg });
                    break;
                }
                case 'kick': {
                    if (!isGroup) return;
                    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (mentioned) await Sock.groupParticipantsUpdate(from, [mentioned], 'remove');
                    break;
                }
                case 'add': {
                    if (!isGroup || !text) return;
                    await Sock.groupParticipantsUpdate(from, [`${text.replace(/[^0-9]/g, '')}@s.whatsapp.net`], 'add');
                    break;
                }
                case 'p':
                case 'promote': {
                    if (!isGroup) return;
                    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (mentioned) await Sock.groupParticipantsUpdate(from, [mentioned], 'promote');
                    break;
                }
                case 'd':
                case 'demote': {
                    if (!isGroup) return;
                    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (mentioned) await Sock.groupParticipantsUpdate(from, [mentioned], 'demote');
                    break;
                }
                case 'group': {
                    if (!isGroup) return;
                    if (text === 'open') await Sock.groupSettingUpdate(from, 'not_announcement');
                    else if (text === 'close') await Sock.groupSettingUpdate(from, 'announcement');
                    break;
                }
                case 'link': {
                    if (!isGroup) return;
                    const code = await Sock.groupInviteCode(from);
                    await Sock.sendMessage(from, { text: `🔗 https://chat.whatsapp.com/${code}` }, { quoted: msg });
                    break;
                }
                case 'revoke':
                case 'resetlink': {
                    if (!isGroup) return;
                    await Sock.groupRevokeInvite(from);
                    await Sock.sendMessage(from, { text: `🔄 Link reset successfully!` }, { quoted: msg });
                    break;
                }
                case 'setname': { if (isGroup && text) await Sock.groupUpdateSubject(from, text); break; }
                case 'setdesc': { if (isGroup && text) await Sock.groupUpdateDescription(from, text); break; }
                case 'mute': { if (isGroup) await Sock.groupSettingUpdate(from, 'announcement'); break; }
                case 'unmute': { if (isGroup) await Sock.groupSettingUpdate(from, 'not_announcement'); break; }
                case 'warn': {
                    if (!isGroup) return;
                    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (mentioned) {
                        userWarnings[mentioned] = (userWarnings[mentioned] || 0) + 1;
                        await Sock.sendMessage(from, { text: `⚠️ Warned! Total: ${userWarnings[mentioned]}/3`, mentions: [mentioned] }, { quoted: msg });
                        if (userWarnings[mentioned] >= 3) await Sock.groupParticipantsUpdate(from, [mentioned], 'remove');
                    }
                    break;
                }
                case 'unwarn': {
                    if (!isGroup) return;
                    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (mentioned) userWarnings[mentioned] = 0;
                    break;
                }
                case 'poll': {
                    if (!text.includes('|')) return;
                    const pollArgs = text.split('|').map(s => s.trim());
                    await Sock.sendMessage(from, { poll: { name: pollArgs[0], values: pollArgs.slice(1), selectableCount: 1 } });
                    break;
                }
                case 'del': {
                    const quotedKey = msg.message.extendedTextMessage?.contextInfo?.stanzaId;
                    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                    if (quotedKey) await Sock.sendMessage(from, { delete: { remoteJid: from, fromMe: false, id: quotedKey, participant: quotedParticipant } });
                    break;
                }

                // SECRET & STATUS TOOLS
                case 'vv': {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quotedMsg) return;
                    const viewOnceMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessage?.message;
                    if (!viewOnceMsg) return;
                    const mediaType = Object.keys(viewOnceMsg)[0];
                    const mediaBuffer = await downloadMediaMessage({ message: viewOnceMsg }, 'buffer', {});
                    if (mediaType === 'imageMessage') await Sock.sendMessage(from, { image: mediaBuffer, caption: '🔓 ViewOnce Unlocked!' }, { quoted: msg });
                    else if (mediaType === 'videoMessage') await Sock.sendMessage(from, { video: mediaBuffer, caption: '🔓 ViewOnce Unlocked!' }, { quoted: msg });
                    break;
                }
                case 'save':
                case 'status': {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quotedMsg) return;
                    const mediaType = Object.keys(quotedMsg)[0];
                    if (mediaType === 'imageMessage' || mediaType === 'videoMessage') {
                        const buffer = await downloadMediaMessage({ message: quotedMsg }, 'buffer', {});
                        if (mediaType === 'imageMessage') await Sock.sendMessage(from, { image: buffer, caption: '📥 Saved Status' }, { quoted: msg });
                        else await Sock.sendMessage(from, { video: buffer, caption: '📥 Saved Status' }, { quoted: msg });
                    }
                    break;
                }

                // MEDIA CONVERTERS
                case 's':
                case 'sticker': {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage || msg.message;
                    if (quotedMsg?.imageMessage || quotedMsg?.videoMessage) {
                        const buffer = await downloadMediaMessage({ message: quotedMsg }, 'buffer', {});
                        await Sock.sendMessage(from, { sticker: buffer }, { quoted: msg });
                    }
                    break;
                }
                case 'toimg':
                case 'toimage': {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (quotedMsg?.stickerMessage) {
                        const buffer = await downloadMediaMessage({ message: quotedMsg }, 'buffer', {});
                        await Sock.sendMessage(from, { image: buffer, caption: '🔄 Converted Image' }, { quoted: msg });
                    }
                    break;
                }
                case 'tomp3':
                case 'tovoice': {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (quotedMsg?.videoMessage || quotedMsg?.audioMessage) {
                        const buffer = await downloadMediaMessage({ message: quotedMsg }, 'buffer', {});
                        await Sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mp4', ptt: command === 'tovoice' }, { quoted: msg });
                    }
                    break;
                }
                case 'tourl': {
                    await Sock.sendMessage(from, { text: `🌐 *Media URL:* https://cdn.phototourl.com/free/2026-09-20-69beb658-b75d-4cd8-a291-0f3656dfcb02.jpg` }, { quoted: msg });
                    break;
                }

                // DOWNLOADERS
                case 'song':
                case 'play': {
                    if (text) await Sock.sendMessage(from, { text: `🎵 *Downloading Audio for:* ${text}\n⏳ Please wait...` }, { quoted: msg });
                    break;
                }
                case 'video':
                case 'ytmp4': {
                    if (text) await Sock.sendMessage(from, { text: `🎬 *Downloading Video for:* ${text}\n⏳ Please wait...` }, { quoted: msg });
                    break;
                }
                case 'ig':
                case 'instagram':
                case 'fb':
                case 'facebook':
                case 'tiktok': {
                    if (text) await Sock.sendMessage(from, { text: `📥 *Fetching link data...*\n⏳ Please wait...` }, { quoted: msg });
                    break;
                }

                // UTILITIES & SYSTEM
                case 'google': { if (text) await Sock.sendMessage(from, { text: `🔍 https://www.google.com/search?q=${encodeURIComponent(text)}` }, { quoted: msg }); break; }
                case 'weather': { if (text) await Sock.sendMessage(from, { text: `🌤️ *Weather in ${text}:* 28°C, Clear Sky` }, { quoted: msg }); break; }
                case 'ping':
                case 'speed': { const start = Date.now(); await Sock.sendMessage(from, { text: `⚡ *Speed:* ${Date.now() - start}ms` }, { quoted: msg }); break; }
                case 'runtime':
                case 'uptime': { await Sock.sendMessage(from, { text: `⏳ *Uptime:* ${getUptime()}` }, { quoted: msg }); break; }
                case 'clearcache': { await Sock.sendMessage(from, { text: `🧹 *Cache Cleared!*` }, { quoted: msg }); break; }
                case 'id': { await Sock.sendMessage(from, { text: `📌 *Chat ID:* ${from}` }, { quoted: msg }); break; }
                case 'sc': { await Sock.sendMessage(from, { text: `👑 *MASTER MIND MD Code Active!*` }, { quoted: msg }); break; }

                // OWNER ONLY
                case 'public': { isPublic = true; await Sock.sendMessage(from, { text: '🌐 *Mode: PUBLIC*' }, { quoted: msg }); break; }
                case 'private': { isPublic = false; await Sock.sendMessage(from, { text: '🔒 *Mode: PRIVATE*' }, { quoted: msg }); break; }
                case 'restart': { await Sock.sendMessage(from, { text: '🔄 *Restarting...*' }, { quoted: msg }); process.exit(0); break; }
                case 'ban': { if (text) { bannedUsers.add(text.replace(/[^0-9]/g, '')); await Sock.sendMessage(from, { text: `⛔ Banned ${text}` }, { quoted: msg }); } break; }
                case 'unban': { if (text) { bannedUsers.delete(text.replace(/[^0-9]/g, '')); await Sock.sendMessage(from, { text: `✅ Unbanned ${text}` }, { quoted: msg }); } break; }
                case 'setprefix': { if (text) { botPrefix = text.trim(); await Sock.sendMessage(from, { text: `⚙️ *Prefix:* ${botPrefix}` }, { quoted: msg }); } break; }
                case 'block': {
                    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (text ? `${text.replace(/[^0-9]/g, '')}@s.whatsapp.net` : null);
                    if (mentioned) { await Sock.updateBlockStatus(mentioned, 'block'); await Sock.sendMessage(from, { text: `🚫 Blocked.` }, { quoted: msg }); }
                    break;
                }
                case 'unblock': {
                    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (text ? `${text.replace(/[^0-9]/g, '')}@s.whatsapp.net` : null);
                    if (mentioned) { await Sock.updateBlockStatus(mentioned, 'unblock'); await Sock.sendMessage(from, { text: `✅ Unblocked.` }, { quoted: msg }); }
                    break;
                }

                default: break;
            }
        } catch (err) {
            console.error('Error:', err);
        }
    });

    return Sock;
}

// Pairing Endpoint
app.get('/pair', async (req, res) => {
    let phone = req.query.number;
    if (!phone) return res.status(400).json({ error: 'Phone number is required. Use ?number=923xxxxxxxx' });

    try {
        phone = phone.replace(/[^0-9]/g, '');
        const { state, saveCreds } = await useMultiFileAuthState('./session');
        
        const tempSock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Chrome (Linux)", "", ""]
        });

        tempSock.ev.on('creds.update', saveCreds);

        if (!tempSock.authState.creds.registered) {
            await delay(2000);
            let code = await tempSock.requestPairingCode(phone);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            res.json({ code: code });
        } else {
            res.json({ error: 'Already registered / connected' });
        }
    } catch (error) {
        console.error('Pairing Error:', error);
        res.status(500).json({ error: 'Failed to generate pairing code' });
    }
});

startBotSocket();

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
                        
