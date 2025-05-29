const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'your_verify_token';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'WhatsApp Gemini Bot is running',
    timestamp: new Date().toISOString(),
    configuration: {
      whatsappBusiness: WHATSAPP_TOKEN ? 'Active' : 'Inactive',
      geminiAI: 'Active'
    }
  });
});

// WhatsApp webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Main webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      body.entry.forEach(async (entry) => {
        const changes = entry.changes;
        changes.forEach(async (change) => {
          if (change.field === 'messages') {
            const messages = change.value.messages;
            if (messages) {
              for (const message of messages) {
                if (message.type === 'text') {
                  const userMessage = message.text.body;
                  const fromNumber = message.from;
                  // Get AI response
                  const aiResponse = await getGeminiResponse(userMessage);
                  // Send response back via WhatsApp Business API
                  await sendWhatsAppMessage(fromNumber, aiResponse.reply || aiResponse);
                  // Handle actions/intents if you want to add integrations (calendar, etc.)
                  // aiResponse.action, aiResponse.params available here
                }
              }
            }
          }
        });
      });
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Gemini AI response function (returns reply AND action/params for integrations)
async function getGeminiResponse(userMessage) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const prompt = `
You are a WhatsApp personal assistant. Analyze the user's message and respond with:
- a natural reply
- a structured "action" and "params" for possible integrations (calendar.add, notes.create, reminder.add, email.send, or none)

User message: "${userMessage}"

Respond ONLY in JSON:
{
  "reply": "Your response to the user",
  "action": "calendar.add|notes.create|reminder.add|email.send|none",
  "params": { }
}
    `;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    // Parse JSON in response
    try {
      const cleaned = response.text().replace(/```json\n?|```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return { reply: response.text(), action: "none", params: {} };
    }
  } catch (error) {
    console.error('Gemini AI error:', error);
    return { reply: "Sorry, I couldn't process your message.", action: "none", params: {} };
  }
}

// Send message via WhatsApp Business API
async function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.log('WhatsApp Business API not configured');
    return;
  }
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Message sent:', response.data);
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
  }
}

// Test endpoint (local dev only)
app.post('/test-ai', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await getGeminiResponse(message);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Gemini Bot running on port ${PORT}`);
  console.log(`🤖 Gemini AI: Enabled`);
});
