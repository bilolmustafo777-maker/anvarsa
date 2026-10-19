# taxi7075 Telegram bot

Haydovchi va yo'lovchi uchun taksi boti (Telegraf + PostgreSQL).

## Funksiyalar

- **Haydovchi**: ism + **jonli lokatsiya** (majburiy) orqali ro'yxatdan o'tadi.
- **Yo'lovchi**: faqat o'z telefon raqamini ulashish orqali ro'yxatdan o'tadi.
- **Buyurtma**: yo'lovchi manzil yuboradi, onlayn haydovchilarga keladi.
- **Bog'lanish**: haydovchi qabul qilsa, yo'lovchiga haydovchi ma'lumoti va jonli lokatsiyasi avtomatik yuboriladi.
- **Admin panel** (`/admin`): onlayn haydovchilar, jonli kuzatuv, ro'yxatlar, statistika.

## Lokal ishga tushirish

```bash
cp .env.example .env   # qiymatlarni to'ldiring
npm install
npm start
```

## Environment o'zgaruvchilari

| Nom | Tavsif |
|---|---|
| `BOT_TOKEN` | BotFather bergan token |
| `DATABASE_URL` | PostgreSQL ulanish manzili |
| `ADMIN_IDS` | Admin Telegram ID'lari, vergul bilan |

## Railway'ga deploy

1. Railway'da **New Project → Deploy from GitHub repo** tanlang.
2. **+ New → Database → PostgreSQL** qo'shing.
3. Bot servisining **Variables** bo'limida `BOT_TOKEN`, `ADMIN_IDS` ni kiriting.
   `DATABASE_URL` ni Postgres servisidan reference qilib oling: `${{Postgres.DATABASE_URL}}`.
4. Railway `npm start` ni avtomatik ishga tushiradi. Jadvallar birinchi ishga tushishda yaratiladi.

## Eslatma

Bot polling rejimida ishlaydi. Yuqori yuklama uchun webhook rejimiga o'tkazish tavsiya etiladi.
