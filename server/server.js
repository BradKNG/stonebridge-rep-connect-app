import express from 'express';
import cors from 'cors';
import dayjs from 'dayjs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// TEMP: open CORS during setup (tighten to your domains later)
app.use(cors());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const JWT_TTL_HOURS = parseInt(process.env.JWT_TTL_HOURS || '72', 10);

// Twilio
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// HubSpot
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || '';
const HS = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: HUBSPOT_TOKEN ? { Authorization: `Bearer ${HUBSPOT_TOKEN}` } : {}
});

// In-memory stores (replace with DB later)
const messages = []; // { id, customer_phone, direction, body, created_at }
const users = [
  // demo user
  { id: 'u1', email: 'rep@example.com', password: 'password', twilio_number: null }
];

// Utils
const id = () => crypto.randomUUID();
const now = () => dayjs().toISOString();
const normalizeUS = (p) => {
  if (!p) return p;
  const digits = String(p).replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
  if (digits.startsWith('+')) return digits;
  return `+${digits}`;
};

// HubSpot logging (best-effort; don’t block)
async function logToHubSpot({ from, to, body, ts }) {
  if (!HUBSPOT_TOKEN) return;
  try {
    const phone = normalizeUS(from || to);
    // Find or create contact
    const search = await HS.post('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
      properties: ['phone', 'firstname', 'lastname']
    });
    let contactId = search.data?.results?.[0]?.id;
    if (!contactId) {
      const created = await HS.post('/crm/v3/objects/contacts', {
        properties: { phone }
      });
      contactId = created.data.id;
    }
    // Create note engagement
    await HS.post('/crm/v3/objects/notes', {
      properties: {
        hs_timestamp: ts,
        hs_note_body: `SMS ${from ? 'from ' + from : ''}${to ? ' to ' + to : ''}\n\n${body}`
      },
      associations: contactId ? [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 203 }]
      }] : []
    });
  } catch (e) {
    console.error('HubSpot log error', e?.response?.data || e.message);
  }
}

// Auth
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const u = users.find(x => x.email === email);
  if (!u || password !== u.password) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ sub: u.id, email: u.email }, JWT_SECRET, { expiresIn: `${JWT_TTL_HOURS}h` });
  res.json({ token, user: { id: u.id, email: u.email } });
});

// Simple auth middleware
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Health check
app.get('/healthz', (req, res) => res.send('ok'));

// Conversations (group by customer_phone)
app.get('/conversations', requireAuth, (req, res) => {
  const map = new Map();
  for (const m of messages) {
    const k = m.customer_phone;
    const prev = map.get(k);
    if (!prev || prev.last_at < m.created_at) map.set(k, { customer_phone: k, last_at: m.created_at });
  }
  res.json([...map.values()].sort((a,b)=> (a.last_at < b.last_at ? 1 : -1)));
});

// List messages with a phone
app.get('/messages', requireAuth, (req, res) => {
  const phone = normalizeUS(req.query.phone);
  const list = messages.filter(m => m.customer_phone === phone).sort((a,b)=> (a.created_at < b.created_at ? -1 : 1));
  res.json(list);
});

// Send message
app.post('/messages', requireAuth, async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });
    if (!twilioClient || !TWILIO_MESSAGING_SERVICE_SID) return res.status(500).json({ error: 'Twilio not configured' });

    const toNorm = normalizeUS(to);
    const resp = await twilioClient.messages.create({
      to: toNorm,
      body,
      messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID
    });

    const msg = { id: id(), customer_phone: toNorm, direction: 'outbound', body, created_at: now() };
    messages.push(msg);

    // Log to HubSpot (fire & forget)
    logToHubSpot({ from: null, to: toNorm, body, ts: msg.created_at }).catch(()=>{});

    res.json({ ok: true, sid: resp.sid, message: msg });
  } catch (e) {
    console.error('Send error', e?.response?.data || e.message);
    res.status(500).json({ error: 'Send failed' });
  }
});

// Twilio inbound webhook
app.post('/webhooks/twilio-sms', async (req, res) => {
  try {
    const from = normalizeUS(req.body.From);
    const body = req.body.Body || '';
    const msg = { id: id(), customer_phone: from, direction: 'inbound', body, created_at: now() };
    messages.push(msg);

    // Log to HubSpot
    logToHubSpot({ from, to: null, body, ts: msg.created_at }).catch(()=>{});

    // Twilio expects 200 quickly
    res.type('text/xml').send('<Response/>');
  } catch (e) {
    console.error('Webhook error', e?.response?.data || e.message);
    res.status(200).type('text/xml').send('<Response/>');
  }
});

// Start
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
});
