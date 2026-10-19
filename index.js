require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map(s => Number(s.trim())).filter(Boolean);
const ONLINE_SEC = 300; // 5 daqiqa ichida yangilangan haydovchi "onlayn" hisoblanadi

const isAdmin = id => ADMIN_IDS.includes(id);

// ---------- DB ----------
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id      BIGINT PRIMARY KEY,
      role       TEXT,
      name       TEXT,
      phone      TEXT,
      state      TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS driver_locations (
      tg_id      BIGINT PRIMARY KEY,
      lat        DOUBLE PRECISION,
      lng        DOUBLE PRECISION,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id           SERIAL PRIMARY KEY,
      passenger_id BIGINT,
      driver_id    BIGINT,
      p_lat        DOUBLE PRECISION,
      p_lng        DOUBLE PRECISION,
      status       TEXT DEFAULT 'open',
      relay_msg_id INT,
      created_at   TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS admin_watch (
      admin_id  BIGINT,
      driver_id BIGINT,
      msg_id    INT,
      PRIMARY KEY (admin_id, driver_id)
    );
  `);
}

async function getUser(id) {
  return (await db.query('SELECT * FROM users WHERE tg_id=$1', [id])).rows[0];
}

async function patchUser(id, patch) {
  await db.query('INSERT INTO users (tg_id) VALUES ($1) ON CONFLICT (tg_id) DO NOTHING', [id]);
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
  await db.query(`UPDATE users SET ${sets} WHERE tg_id=$1`, [id, ...keys.map(k => patch[k])]);
}

async function saveDriverLoc(id, lat, lng) {
  await db.query(`
    INSERT INTO driver_locations (tg_id, lat, lng, updated_at) VALUES ($1,$2,$3,now())
    ON CONFLICT (tg_id) DO UPDATE SET lat=$2, lng=$3, updated_at=now()`, [id, lat, lng]);
}

async function onlineDrivers() {
  return (await db.query(`
    SELECT u.tg_id, u.name, u.phone, l.lat, l.lng, l.updated_at
    FROM users u JOIN driver_locations l ON l.tg_id = u.tg_id
    WHERE u.role='driver' AND u.state='active'
      AND l.updated_at > now() - interval '${ONLINE_SEC} seconds'`)).rows;
}

// Haydovchi lokatsiyasi o'zgarganda: qabul qilingan buyurtma yo'lovchisiga
// va kuzatayotgan adminlarga jonli lokatsiyani yangilaydi
async function relayLocation(driverId, lat, lng) {
  const orders = (await db.query(
    `SELECT passenger_id, relay_msg_id FROM orders
     WHERE driver_id=$1 AND status='accepted' AND relay_msg_id IS NOT NULL`, [driverId])).rows;
  for (const o of orders) {
    await bot.telegram.callApi('editMessageLiveLocation', {
      chat_id: o.passenger_id, message_id: o.relay_msg_id, latitude: lat, longitude: lng,
    }).catch(() => {});
  }
  const watches = (await db.query(
    'SELECT admin_id, msg_id FROM admin_watch WHERE driver_id=$1', [driverId])).rows;
  for (const w of watches) {
    await bot.telegram.callApi('editMessageLiveLocation', {
      chat_id: w.admin_id, message_id: w.msg_id, latitude: lat, longitude: lng,
    }).catch(() => {});
  }
}

// ---------- /start va rol tanlash ----------
bot.start(async ctx => {
  const u = await getUser(ctx.from.id);
  if (u?.state === 'active') {
    return ctx.reply(`Siz allaqachon ro'yxatdan o'tgansiz (${u.role === 'driver' ? 'haydovchi' : "yo'lovchi"}).`);
  }
  await patchUser(ctx.from.id, { state: 'new', role: null });
  return ctx.reply('Assalomu alaykum! Rolingizni tanlang:',
    Markup.keyboard([['🚖 Haydovchi', "🧍 Yo'lovchi"]]).resize().oneTime());
});

bot.hears('🚖 Haydovchi', async ctx => {
  const u = await getUser(ctx.from.id);
  if (u?.state === 'active') return ctx.reply("Siz allaqachon ro'yxatdan o'tgansiz.");
  await patchUser(ctx.from.id, { role: 'driver', state: 'await_name' });
  return ctx.reply("Ismingizni kiriting:", Markup.removeKeyboard());
});

bot.hears("🧍 Yo'lovchi", async ctx => {
  const u = await getUser(ctx.from.id);
  if (u?.state === 'active') return ctx.reply("Siz allaqachon ro'yxatdan o'tgansiz.");
  await patchUser(ctx.from.id, { role: 'passenger', state: 'await_phone' });
  return ctx.reply("Ro'yxatdan o'tish uchun telefon raqamingizni yuboring:",
    Markup.keyboard([[Markup.button.contactRequest('📱 Raqamni yuborish')]]).resize().oneTime());
});

// Yo'lovchi: faqat o'z telefon raqami orqali ro'yxatdan o'tadi
bot.on('contact', async ctx => {
  const u = await getUser(ctx.from.id);
  if (u?.state !== 'await_phone') return;
  if (ctx.message.contact.user_id !== ctx.from.id) {
    return ctx.reply("Faqat o'zingizning raqamingizni yuboring.");
  }
  await patchUser(ctx.from.id, {
    phone: ctx.message.contact.phone_number,
    name: ctx.from.first_name,
    state: 'active',
  });
  return ctx.reply("✅ Ro'yxatdan o'tdingiz! Manzilingizni (📎 → Joylashuv) yuborib buyurtma bering.",
    Markup.removeKeyboard());
});

// ---------- Matn (haydovchi ismi) ----------
bot.on('text', async (ctx, next) => {
  const u = await getUser(ctx.from.id);
  if (u?.state === 'await_name') {
    await patchUser(ctx.from.id, {
      name: ctx.message.text.trim().slice(0, 64),
      state: 'await_location',
    });
    return ctx.reply(
      '📍 Endi JONLI lokatsiyani yuboring:\n' +
      '📎 → Joylashuv → "Jonli joylashuvni ulashish" (Share Live Location).\n' +
      "Jonli lokatsiya ulanmaguncha ro'yxatdan o'tib bo'lmaydi.");
  }
  if (u?.state === 'await_location') {
    return ctx.reply("⚠️ Oddiy joylashuv qabul qilinmaydi. Iltimos, JONLI lokatsiyani yuboring.");
  }
  if (u?.state === 'await_phone') {
    return ctx.reply("Telefon raqamingizni tugma orqali yuboring: 📱 Raqamni yuborish.");
  }
  return next();
});

// ---------- Lokatsiya (yangi xabar) ----------
bot.on('location', async ctx => {
  const id = ctx.from.id;
  const u = await getUser(id);
  const loc = ctx.message.location;

  // Haydovchi ro'yxatdan o'tishi: jonli lokatsiya MAJBURIY
  if (u?.state === 'await_location') {
    if (!loc.live_period) {
      return ctx.reply('⚠️ Jonli lokatsiya kerak. 📎 → Joylashuv → "Jonli joylashuvni ulashish".');
    }
    await patchUser(id, { state: 'active' });
    await saveDriverLoc(id, loc.latitude, loc.longitude);
    return ctx.reply(`✅ Ro'yxatdan o'tdingiz, ${u.name}! Jonli lokatsiyangizni yoqilgan holda qoldiring.`);
  }

  if (u?.role === 'driver' && u.state === 'active') {
    await saveDriverLoc(id, loc.latitude, loc.longitude);
    return;
  }

  // Yo'lovchi: buyurtma (manzil yuboriladi)
  if (u?.role === 'passenger' && u.state === 'active') {
    const { rows } = await db.query(
      'INSERT INTO orders (passenger_id, p_lat, p_lng) VALUES ($1,$2,$3) RETURNING id',
      [id, loc.latitude, loc.longitude]);
    const orderId = rows[0].id;
    const drivers = await onlineDrivers();
    if (!drivers.length) {
      return ctx.reply("Hozir faol haydovchi yo'q. Keyinroq urinib ko'ring.");
    }
    for (const d of drivers) {
      await bot.telegram.sendMessage(d.tg_id,
        `🆕 Yangi buyurtma #${orderId}\nYo'lovchi: ${u.name}`,
        Markup.inlineKeyboard([[Markup.button.callback('✅ Qabul qilish', `accept:${orderId}`)]]))
        .catch(() => {});
      await bot.telegram.sendLocation(d.tg_id, loc.latitude, loc.longitude).catch(() => {});
    }
    return ctx.reply(`✅ Buyurtma #${orderId} yuborildi. Haydovchi qabul qilishini kuting...`);
  }
});

// Jonli lokatsiya yangilanishlari shu yerga keladi
bot.on('edited_message', async ctx => {
  const m = ctx.editedMessage;
  if (!m?.location) return;
  const id = m.from.id;
  const u = await getUser(id);
  if (u?.role !== 'driver' || u.state !== 'active') return;
  await saveDriverLoc(id, m.location.latitude, m.location.longitude);
  await relayLocation(id, m.location.latitude, m.location.longitude);
});

// ---------- Haydovchi buyurtmani qabul qiladi ----------
bot.action(/^accept:(\d+)$/, async ctx => {
  const orderId = Number(ctx.match[1]);
  const driverId = ctx.from.id;
  const d = await getUser(driverId);
  if (d?.role !== 'driver' || d.state !== 'active') {
    return ctx.answerCbQuery("Faqat ro'yxatdan o'tgan haydovchilar.", { show_alert: true });
  }

  const { rows } = await db.query(
    `UPDATE orders SET status='accepted', driver_id=$2
     WHERE id=$1 AND status='open' RETURNING *`, [orderId, driverId]);
  if (!rows.length) return ctx.answerCbQuery('Bu buyurtma allaqachon olingan.', { show_alert: true });
  const o = rows[0];

  // Haydovchining oxirgi lokatsiyasini yo'lovchiga jonli ko'rinishda yuborish
  const loc = (await db.query('SELECT lat, lng FROM driver_locations WHERE tg_id=$1', [driverId])).rows[0];
  const sent = await bot.telegram.callApi('sendLocation', {
    chat_id: o.passenger_id, latitude: loc.lat, longitude: loc.lng, live_period: 1800,
  });
  await db.query('UPDATE orders SET relay_msg_id=$2 WHERE id=$1', [orderId, sent.message_id]);

  const p = await getUser(o.passenger_id);
  await bot.telegram.sendMessage(o.passenger_id,
    `🚖 Haydovchi topildi!\nIsm: ${d.name}${d.phone ? `\nTelefon: ${d.phone}` : ''}\n` +
    "Haydovchining jonli lokatsiyasi yuqorida. U harakatlanganda yangilanadi.");

  await bot.telegram.sendLocation(driverId, o.p_lat, o.p_lng);
  await bot.telegram.sendMessage(driverId,
    `✅ Buyurtma #${orderId} sizga biriktirildi.\nYo'lovchi: ${p.name}${p.phone ? `, ${p.phone}` : ''}`);
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  return ctx.answerCbQuery('Qabul qilindi ✅');
});

// ---------- Admin panel ----------
const adminMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🗺 Jonli haydovchilar', 'adm:live')],
  [Markup.button.callback('👥 Haydovchilar', 'adm:drivers'),
   Markup.button.callback("🧍 Yo'lovchilar", 'adm:passengers')],
  [Markup.button.callback('📊 Statistika', 'adm:stats')],
]);

bot.command('admin', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  return ctx.reply('🔐 Admin panel', adminMenu);
});

bot.action('adm:back', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.editMessageText('🔐 Admin panel', adminMenu).catch(() => {});
  return ctx.answerCbQuery();
});

bot.action('adm:live', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const drivers = await onlineDrivers();
  const back = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Orqaga', 'adm:back')]]);
  if (!drivers.length) {
    await ctx.editMessageText("Hozir onlayn haydovchi yo'q.", back);
    return ctx.answerCbQuery();
  }
  const rows = drivers.map(d => [Markup.button.callback(
    `📍 ${d.name} (${Math.round((Date.now() - new Date(d.updated_at)) / 1000)}s oldin)`,
    `adm:watch:${d.tg_id}`)]);
  rows.push([Markup.button.callback('⬅️ Orqaga', 'adm:back')]);
  await ctx.editMessageText('Kuzatish uchun haydovchini tanlang (jonli yangilanadi):',
    Markup.inlineKeyboard(rows));
  return ctx.answerCbQuery();
});

// Admin haydovchini jonli kuzatadi: lokatsiya xabari har o'zgarishda yangilanadi
bot.action(/^adm:watch:(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const driverId = Number(ctx.match[1]);
  const loc = (await db.query('SELECT lat, lng FROM driver_locations WHERE tg_id=$1', [driverId])).rows[0];
  const d = await getUser(driverId);
  if (!loc) return ctx.answerCbQuery('Lokatsiya topilmadi.', { show_alert: true });
  await ctx.reply(`📍 ${d.name}${d.phone ? ` (${d.phone})` : ''} — jonli kuzatuv`);
  const sent = await bot.telegram.callApi('sendLocation', {
    chat_id: ctx.from.id, latitude: loc.lat, longitude: loc.lng, live_period: 3600,
  });
  await db.query(`
    INSERT INTO admin_watch (admin_id, driver_id, msg_id) VALUES ($1,$2,$3)
    ON CONFLICT (admin_id, driver_id) DO UPDATE SET msg_id=$3`,
    [ctx.from.id, driverId, sent.message_id]);
  return ctx.answerCbQuery('Kuzatuv yoqildi');
});

bot.action('adm:drivers', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const { rows } = await db.query(`
    SELECT u.name, u.phone, u.state, (l.updated_at > now() - interval '${ONLINE_SEC} seconds') AS online
    FROM users u LEFT JOIN driver_locations l ON l.tg_id=u.tg_id
    WHERE u.role='driver' ORDER BY u.created_at DESC LIMIT 30`);
  const text = rows.length
    ? rows.map(r => `${r.online ? '🟢' : '⚪️'} ${r.name || '—'} ${r.phone || ''} [${r.state}]`).join('\n')
    : "Haydovchilar yo'q.";
  await ctx.editMessageText(`👥 Haydovchilar:\n${text}`,
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Orqaga', 'adm:back')]]));
  return ctx.answerCbQuery();
});

bot.action('adm:passengers', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const { rows } = await db.query(
    `SELECT name, phone FROM users WHERE role='passenger' AND state='active'
     ORDER BY created_at DESC LIMIT 30`);
  const text = rows.length ? rows.map(r => `• ${r.name} ${r.phone}`).join('\n') : "Yo'lovchilar yo'q.";
  await ctx.editMessageText(`🧍 Yo'lovchilar:\n${text}`,
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Orqaga', 'adm:back')]]));
  return ctx.answerCbQuery();
});

bot.action('adm:stats', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  const s = (await db.query(`
    SELECT
      (SELECT count(*) FROM users WHERE role='driver' AND state='active') AS drivers,
      (SELECT count(*) FROM users WHERE role='passenger' AND state='active') AS passengers,
      (SELECT count(*) FROM orders) AS orders,
      (SELECT count(*) FROM orders WHERE status='accepted') AS accepted`)).rows[0];
  const online = (await onlineDrivers()).length;
  await ctx.editMessageText(
    `📊 Statistika\n\nHaydovchilar: ${s.drivers} (onlayn: ${online})\n` +
    `Yo'lovchilar: ${s.passengers}\nBuyurtmalar: ${s.orders}\nQabul qilingan: ${s.accepted}`,
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Orqaga', 'adm:back')]]));
  return ctx.answerCbQuery();
});

// ---------- Xatolar va ishga tushirish ----------
bot.catch((err, ctx) => {
  console.error(`Xato (update ${ctx.update.update_id}):`, err);
});

(async () => {
  await initDb();
  await bot.launch();
  console.log('Bot ishga tushdi');
})().catch(err => {
  console.error('Ishga tushmadi:', err);
  process.exit(1);
});

process.once('SIGINT', () => { bot.stop('SIGINT'); db.end(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); db.end(); });
