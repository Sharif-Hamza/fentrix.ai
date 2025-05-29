const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

const app = express();

// Environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'your_verify_token';

let genAI;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
} else {
  console.warn('⚠️ No GEMINI_API_KEY provided. Using mock responses for local testing.');
}

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
    console.log('Received webhook call:', JSON.stringify(req.body, null, 2));
    const body = req.body;
    res.status(200).send('EVENT_RECEIVED');

    if (body.object === 'whatsapp_business_account') {
      if (!body.entry || body.entry.length === 0) return;
      for (const entry of body.entry) {
        if (!entry.changes || entry.changes.length === 0) continue;
        for (const change of entry.changes) {
          if (change.field === 'messages') {
            const value = change.value;
            if (!value || !value.messages || value.messages.length === 0) continue;
            for (const message of value.messages) {
              if (message.type === 'text') {
                const userMessage = message.text.body;
                const fromNumber = message.from;
                try {
                  const aiResponse = await getGeminiResponse(userMessage);
                  const replyText = aiResponse.reply || aiResponse;
                  await sendWhatsAppMessage(fromNumber, replyText);

                  // n8n integration for email.send
                  if (aiResponse.action && aiResponse.action !== 'none') {
                    if (aiResponse.action === 'email.send') {
                      try {
                        const emailPayload = {
                          to: aiResponse.params.to,
                          subject: aiResponse.params.subject,
                          body: aiResponse.params.body
                        };
                        const n8nResp = await axios.post(
                          'https://areenxo.app.n8n.cloud/webhook/whatsapp-email',
                          emailPayload
                        );
                        await sendWhatsAppMessage(fromNumber, 'Your email has been sent!');
                      } catch (n8nErr) {
                        await sendWhatsAppMessage(fromNumber, 'Sorry, I was unable to send the email.');
                      }
                    }
                  }
                } catch (messageError) {
                  console.error('Error processing message:', messageError);
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Webhook error:', error);
  }
});

async function getGeminiResponse(userMessage) {
  if (!GEMINI_API_KEY) {
    if (userMessage.toLowerCase().includes('email')) {
      return {
        reply: "I'll draft that email for you right away.",
        action: "email.send",
        params: {
          to: "recipient@example.com",
          subject: "Example Subject",
          body: "This is a test email body."
        }
      };
    }
    return {
      reply: "Hello! This is a mock response.",
      action: "none",
      params: {}
    };
  }
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `
You are a helpful WhatsApp personal assistant powered by Gemini 2.0. Analyze the user's message and respond with:
- a natural, conversational reply
- a structured "action" and "params" for integrations and automations

Available actions:
1. calendar.add - Add calendar events (params: title, date, time, description)
2. notes.create - Create notes (params: title, content, tags)
3. reminder.add - Set reminders (params: text, date, time, priority)
4. email.send - Send emails (params: to, subject, body)
5. none - No action required

User message: "${userMessage}"

Respond ONLY in JSON:
{
  "reply": "Your conversational response to the user",
  "action": "calendar.add|notes.create|reminder.add|email.send|none",
  "params": { }
}
    `;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    try {
      const cleaned = response.text().replace(/```json\n?|```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return { reply: response.text(), action: "none", params: {} };
    }
  } catch (error) {
    return { reply: "Sorry, I couldn't process your message.", action: "none", params: {} };
  }
}

async function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    return { success: false, error: 'Not configured' };
  }
  try {
    const formattedNumber = to.startsWith('+') ? to.substring(1) : to;
    const payload = {
      messaging_product: 'whatsapp',
      to: formattedNumber,
      text: { body: message }
    };
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.response?.data || error.message };
  }
}

// --- DEV TESTS, UI, ETC: Safe to keep if you want! ---
app.post('/test-ai', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await getGeminiResponse(message);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test-chat', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Gemini Bot Tester</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    #chat-container { height: 400px; border: 1px solid #ccc; overflow-y: auto; padding: 10px; margin-bottom: 10px; border-radius: 5px; }
    #message-form { display: flex; }
    #message-input { flex-grow: 1; padding: 10px; border: 1px solid #ccc; border-radius: 5px; margin-right: 10px; }
    button { background: #25D366; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; }
    .message { margin-bottom: 10px; padding: 8px 12px; border-radius: 5px; max-width: 70%; }
    .user-message { background-color: #DCF8C6; align-self: flex-end; margin-left: auto; }
    .bot-message { background-color: #f1f1f1; }
    .message-container { display: flex; flex-direction: column; }
    .action-box { background-color: #E7F3FF; padding: 10px; border-radius: 5px; margin-top: 5px; font-size: 0.9em; }
    h1 { color: #128C7E; }
  </style>
</head>
<body>
  <h1>WhatsApp Gemini Bot Tester</h1>
  <div id="chat-container"></div>
  <form id="message-form">
    <input type="text" id="message-input" placeholder="Type a message..." autocomplete="off">
    <button type="submit">Send</button>
  </form>
  <script>
    const chatContainer = document.getElementById('chat-container');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    messageForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const message = messageInput.value.trim();
      if (!message) return;
      addMessage(message, 'user');
      messageInput.value = '';
      try {
        const response = await fetch('/test-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        const data = await response.json();
        addMessage(data.reply, 'bot', data.action, data.params);
      } catch (error) {
        addMessage('Sorry, something went wrong', 'bot');
      }
    });
    function addMessage(text, sender, action = 'none', params = {}) {
      const messageContainer = document.createElement('div');
      messageContainer.className = 'message-container';
      const messageElement = document.createElement('div');
      messageElement.className = 'message ' + sender + '-message';
      messageElement.textContent = text;
      messageContainer.appendChild(messageElement);
      if (sender === 'bot' && action !== 'none') {
        const actionBox = document.createElement('div');
        actionBox.className = 'action-box';
        actionBox.innerHTML = '<strong>Action:</strong> ' + action + '<br><strong>Params:</strong> ' + JSON.stringify(params);
        messageContainer.appendChild(actionBox);
      }
      chatContainer.appendChild(messageContainer);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    addMessage('Welcome! I\'m your WhatsApp Gemini Bot. How can I help you today?', 'bot');
  </script>
</body>
</html>
  `);
});

app.post('/test-webhook', async (req, res) => {
  try {
    const { message, phone = '123456789' } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const aiResponse = await getGeminiResponse(message);
    res.json({
      success: true,
      response: aiResponse,
      simulation: {
        to: phone,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

// ---- IMPORTANT ----
// REMOVE app.listen() FOR BACK4APP!
// ---- DO NOT USE: app.listen(PORT, () => { ... });
// ---- INSTEAD:
module.exports = app;



