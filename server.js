const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001; // Changed to 3001 to avoid conflicts

// Environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'your_verify_token';

// For local testing, we'll create a mock Gemini client if no API key is provided
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

// Main webhook handler for WhatsApp
app.post('/webhook', async (req, res) => {
  try {
    console.log('Received webhook call:', JSON.stringify(req.body, null, 2));
    const body = req.body;
    
    // Always return 200 immediately to acknowledge receipt
    res.status(200).send('EVENT_RECEIVED');
    
    // Check if this is a verification request
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook verified!');
      return;
    }
    
    if (body.object === 'whatsapp_business_account') {
      console.log('Processing WhatsApp Business Account webhook');
      
      if (!body.entry || body.entry.length === 0) {
        console.log('No entries in webhook, ignoring');
        return;
      }
      
      for (const entry of body.entry) {
        if (!entry.changes || entry.changes.length === 0) {
          console.log('No changes in entry, ignoring');
          continue;
        }
        
        for (const change of entry.changes) {
          if (change.field === 'messages') {
            console.log('Processing messages field in webhook');
            
            const value = change.value;
            if (!value || !value.messages || value.messages.length === 0) {
              console.log('No messages in value, ignoring');
              continue;
            }
            
            console.log(`Found ${value.messages.length} message(s) to process`);
            
            for (const message of value.messages) {
              if (message.type === 'text') {
                console.log('Processing text message:', message.text.body);
                const userMessage = message.text.body;
                const fromNumber = message.from;
                
                console.log(`Message from ${fromNumber}: ${userMessage}`);
                
                try {
                  // Check if this is a command-based message (starts with /)
                  if (userMessage && userMessage.startsWith('/')) {
                    console.log('Command detected:', userMessage);
                    
                    // Execute the command directly
                    const actionResult = await handleCommandBasedIntegration(userMessage, fromNumber);
                    
                    // Send response based on the command execution
                    let responseMessage;
                    if (actionResult.success) {
                      responseMessage = `✅ Command executed successfully: ${actionResult.message}`;
                    } else {
                      responseMessage = `❌ Command failed: ${actionResult.message}`;
                    }
                    
                    await sendWhatsAppMessage(fromNumber, responseMessage);
                    console.log('Command response sent successfully!');
                  } else {
                    // For regular messages, get AI response
                    console.log('Getting Gemini response...');
                    const aiResponse = await getGeminiResponse(userMessage);
                    console.log('Gemini response:', JSON.stringify(aiResponse));
                    
                    // Send the reply
                    console.log(`Sending reply to ${fromNumber}: ${aiResponse.reply}`);
                    await sendWhatsAppMessage(fromNumber, aiResponse.reply);
                    console.log('Reply sent successfully!');
                    
                    // Execute any action if AI detected one
                    if (aiResponse.action && aiResponse.action !== 'none') {
                      console.log(`Processing action: ${aiResponse.action}`, aiResponse.params);
                      const actionResult = await executeAction(aiResponse.action, aiResponse.params, userMessage, fromNumber);
                      if (actionResult.success && actionResult.message !== 'No action needed') {
                        // Send a follow-up message about the action
                        await sendWhatsAppMessage(fromNumber, `✅ ${actionResult.message}`);
                      }
                    }
                  }
                } catch (messageError) {
                  console.error('Error processing message:', messageError);
                  try {
                    await sendWhatsAppMessage(fromNumber, "Sorry, I encountered an error processing your message. Please try again.");
                  } catch (sendError) {
                    console.error('Error sending error message:', sendError);
                  }
                }
              } else {
                console.log(`Ignoring non-text message of type: ${message.type}`);
              }
            }
          }
        }
      }
    } else {
      console.log(`Ignoring webhook for non-WhatsApp object: ${body.object}`);
    }
  } catch (error) {
    console.error('Webhook error:', error);
    // We already sent a 200 response, so no need to respond again
  }
});

// Gemini AI response function (returns reply AND action/params for integrations)
async function getGeminiResponse(userMessage) {
  // If no API key is provided, return mock responses for testing
  if (!GEMINI_API_KEY) {
    console.log('Using mock response for message:', userMessage);
    
    // Simple pattern matching for testing automation features
    if (userMessage.toLowerCase().includes('reminder')) {
      return {
        reply: "I've set a reminder for you as requested.",
        action: "reminder.add",
        params: {
          text: "Example reminder",
          date: new Date().toISOString().split('T')[0],
          time: "12:00",
          priority: "normal"
        }
      };
    } else if (userMessage.toLowerCase().includes('email')) {
      return {
        reply: "I'll draft that email for you right away.",
        action: "email.send",
        params: {
          to: "recipient@example.com",
          subject: "Example Subject",
          body: "This is a test email body.",
          cc: "",
          bcc: ""
        }
      };
    } else if (userMessage.toLowerCase().includes('weather')) {
      return {
        reply: "Here's the current weather information.",
        action: "weather.get",
        params: {
          location: "New York",
          units: "imperial"
        }
      };
    } else if (userMessage.toLowerCase().includes('note')) {
      return {
        reply: "I've created a note with that information.",
        action: "notes.create",
        params: {
          title: "Example Note",
          content: "This is the content of your note.",
          tags: ["test", "example"]
        }
      };
    } else if (userMessage.toLowerCase().includes('calendar') || userMessage.toLowerCase().includes('schedule') || userMessage.toLowerCase().includes('meeting')) {
      return {
        reply: "I've added that event to your calendar.",
        action: "calendar.add",
        params: {
          title: "Test Meeting",
          date: new Date().toISOString().split('T')[0],
          time: "15:00",
          description: "This is a test calendar event."
        }
      };
    } else if (userMessage.toLowerCase().includes('search')) {
      return {
        reply: "Here are some search results for you.",
        action: "search.web",
        params: {
          query: userMessage.replace(/search/gi, "").trim() || "example search",
          limit: 5
        }
      };
    } else {
      return {
        reply: "Hello! This is a mock response since you're running in test mode without an API key. Try asking about reminders, emails, weather, notes, calendar, or search to see different automation examples.",
        action: "none",
        params: {}
      };
    }
  }
  
  // If API key is provided, use the actual Gemini API
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Using the publicly available Gemini 2.0 Flash model
    const prompt = `
You are a helpful WhatsApp personal assistant powered by Gemini 2.0. Analyze the user's message and respond with:
- a natural, conversational reply
- a structured "action" and "params" for integrations and automations

Available actions:
1. calendar.add - Add calendar events (params: title, date, time, description)
2. notes.create - Create notes (params: title, content, tags)
3. reminder.add - Set reminders (params: text, date, time, priority)
4. email.send - Send emails (params: to, subject, body, cc, bcc)
5. weather.get - Get weather information (params: location, units)
6. search.web - Search the web (params: query, limit)
7. none - No action required

User message: "${userMessage}"

Respond ONLY in JSON:
{
  "reply": "Your conversational response to the user",
  "action": "calendar.add|notes.create|reminder.add|email.send|weather.get|search.web|none",
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
  
  console.log('Attempting to send WhatsApp message to:', to);
  console.log('Message content:', message);
  
  try {
    // Make sure phone number is in the correct format (should start with country code, no + symbol)
    const formattedNumber = to.startsWith('+') ? to.substring(1) : to;
    
    const payload = {
      messaging_product: 'whatsapp',
      to: formattedNumber,
      text: { body: message }
    };
    
    console.log('Request payload:', JSON.stringify(payload));
    console.log('Using Phone ID:', WHATSAPP_PHONE_ID);
    
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
    
    console.log('Message sent successfully! Response:', JSON.stringify(response.data));
    return { success: true, data: response.data };
  } catch (error) {
    console.error('Error sending WhatsApp message:');
    if (error.response) {
      console.error('Response error data:', JSON.stringify(error.response.data));
      console.error('Response status:', error.response.status);
      
      // Handle specific WhatsApp error codes
      const errorCode = error.response.data?.error?.code;
      const errorMessage = error.response.data?.error?.message;
      
      if (errorCode === 131030) {
        console.error('CRITICAL ERROR: The recipient phone number is not in the allowed list. You must add this number to your test recipients in the Meta Developer Dashboard.');
      } else if (errorCode === 10) {
        console.error('CRITICAL ERROR: Your app does not have the proper permissions or your access token is invalid/expired.');
      }
    } else {
      console.error('Error details:', error.message);
    }
    
    return { success: false, error: error.response?.data || error.message };
  }
}

// Enhanced test endpoints for local development
// Test AI endpoint
app.post('/test-ai', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await getGeminiResponse(message);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat UI for easy testing (local dev only)
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

      // Add user message to chat
      addMessage(message, 'user');
      messageInput.value = '';

      try {
        // Send message to server
        const response = await fetch('/test-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });

        const data = await response.json();

        // Add bot response to chat
        addMessage(data.reply, 'bot', data.action, data.params);
      } catch (error) {
        console.error('Error:', error);
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

      // Add action info if it's not 'none'
      if (sender === 'bot' && action !== 'none') {
        const actionBox = document.createElement('div');
        actionBox.className = 'action-box';
        actionBox.innerHTML = '<strong>Action:</strong> ' + action + '<br><strong>Params:</strong> ' + JSON.stringify(params);
        messageContainer.appendChild(actionBox);
      }

      chatContainer.appendChild(messageContainer);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // Add welcome message
    addMessage('Welcome! I\'m your WhatsApp Gemini Bot. How can I help you today?', 'bot');
  </script>
</body>
</html>
  `);
});

// Fake webhook simulator for testing without actual WhatsApp integration
app.post('/test-webhook', async (req, res) => {
  try {
    const { message, phone = '123456789' } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Get AI response
    const aiResponse = await getGeminiResponse(message);
    
    // Log the response that would be sent to WhatsApp
    console.log('Simulated WhatsApp message to:', phone);
    console.log('Bot response:', aiResponse.reply);
    console.log('Action:', aiResponse.action);
    console.log('Params:', aiResponse.params);
    
    res.json({
      success: true,
      response: aiResponse,
      simulation: {
        to: phone,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Test webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

// Add handling for automation actions (for future implementation)
const N8N_EMAIL_WEBHOOK = 'https://areenxo.app.n8n.cloud/webhook-test/whatsapp-email';

// Store conversation states for users
const userConversationStates = {};

async function executeAction(action, params, userMessage, fromNumber) {
  console.log(`Executing action: ${action}`);
  console.log('With params:', params);
  
  // Process command-based integrations first
  if (userMessage && userMessage.startsWith('/')) {
    return await handleCommandBasedIntegration(userMessage, fromNumber);
  }
  
  // Process AI-detected actions
  switch(action) {
    case 'email.send':
      return await sendEmailViaN8n(params, fromNumber);
    
    case 'calendar.add':
      // Implement calendar event creation
      return { success: true, message: 'Calendar event would be created (not actually implemented yet)' };
    
    case 'reminder.add':
      // Implement reminder creation
      return { success: true, message: 'Reminder would be set (not actually implemented yet)' };
    
    case 'notes.create':
      // Implement note creation
      return { success: true, message: 'Note would be created (not actually implemented yet)' };
    
    case 'weather.get':
      // Implement weather information retrieval
      return { success: true, message: 'Weather information would be retrieved (not actually implemented yet)' };
    
    case 'search.web':
      // Implement web search
      return { success: true, message: 'Web search would be performed (not actually implemented yet)' };
    
    case 'none':
      return { success: true, message: 'No action needed' };
    
    default:
      return { success: false, message: `Unknown action: ${action}` };
  }
}

async function handleCommandBasedIntegration(message, fromNumber) {
  const command = message.split(' ')[0].toLowerCase();
  const content = message.slice(command.length).trim();
  
  console.log(`Processing command: ${command}`);
  console.log(`Command content: ${content}`);
  
  // Handle conversation states
  if (userConversationStates[fromNumber]) {
    const conversationState = userConversationStates[fromNumber];
    
    // Check if user is in the middle of an email conversation flow
    if (conversationState.flow === 'email') {
      return await continueEmailFlow(message, fromNumber, conversationState);
    }
  }
  
  // Handle new commands
  switch(command) {
    case '/email':
      // Initialize email conversation flow
      userConversationStates[fromNumber] = {
        flow: 'email',
        step: 'recipient',
        data: {
          to: '',
          subject: '',
          body: ''
        },
        timestamp: Date.now()
      };
      
      return { 
        success: true, 
        message: "Please enter recipient's email address:" 
      };
      
    // Add other commands here as needed
    default:
      return { success: false, message: `Unknown command: ${command}` };
  }
}

// Handle the conversation flow for collecting email info
async function continueEmailFlow(message, fromNumber, state) {
  console.log(`Continuing email flow, current step: ${state.step}`);
  
  // Expire conversation states after 10 minutes of inactivity
  const expirationTime = 10 * 60 * 1000; // 10 minutes in milliseconds
  if (Date.now() - state.timestamp > expirationTime) {
    delete userConversationStates[fromNumber];
    return { success: false, message: "Your email session has expired. Please start again with /email" };
  }
  
  // Update timestamp to keep conversation fresh
  state.timestamp = Date.now();
  
  // Handle different steps of the email flow
  switch(state.step) {
    case 'recipient':
      state.data.to = message.trim();
      state.step = 'subject';
      return { success: true, message: "Great! Now please enter the subject line:" };
      
    case 'subject':
      state.data.subject = message.trim();
      state.step = 'body';
      return { success: true, message: "Perfect! Now type the email body:" };
      
    case 'body':
      state.data.body = message.trim();
      state.step = 'confirmation';
      
      // Show confirmation
      return { 
        success: true, 
        message: `Here's your email:\n\nTo: ${state.data.to}\nSubject: ${state.data.subject}\n\n${state.data.body}\n\nType 'send' to send it or 'cancel' to abort.` 
      };
      
    case 'confirmation':
      if (message.toLowerCase() === 'send') {
        // Send the email
        const result = await sendEmailViaN8n(state.data, fromNumber);
        
        // Clear the conversation state
        delete userConversationStates[fromNumber];
        
        return result;
      } else if (message.toLowerCase() === 'cancel') {
        // Clear the conversation state
        delete userConversationStates[fromNumber];
        
        return { success: false, message: "Email cancelled." };
      } else {
        return { 
          success: false, 
          message: "I didn't understand. Type 'send' to send the email or 'cancel' to abort."
        };
      }
      
    default:
      // Invalid state, reset
      delete userConversationStates[fromNumber];
      return { success: false, message: "Something went wrong with your email. Please try again with /email" };
  }
}

// Legacy function for one-line email parsing (keeping for reference)
function parseEmailCommand(content) {
  const params = { to: '', subject: '', body: '' };
  
  // Simple parsing - in real application you might want a more robust parser
  if (content.includes('to:')) {
    const toMatch = content.match(/to:([^\s]+)/);
    if (toMatch && toMatch[1]) params.to = toMatch[1];
  }
  
  if (content.includes('subject:')) {
    const subjectMatch = content.match(/subject:([^\n]+)/);
    if (subjectMatch && subjectMatch[1]) params.subject = subjectMatch[1].trim();
  }
  
  if (content.includes('body:')) {
    const bodyMatch = content.match(/body:(.+)$/);
    if (bodyMatch && bodyMatch[1]) params.body = bodyMatch[1].trim();
  }
  
  return params;
}

async function sendEmailViaN8n(params, fromNumber) {
  try {
    console.log('Sending email via n8n webhook');
    console.log('Email parameters:', params);
    
    // Add sender information to the payload
    const payload = {
      ...params,
      fromNumber: fromNumber,
      timestamp: new Date().toISOString()
    };
    
    // Call the n8n webhook
    const response = await axios.post(N8N_EMAIL_WEBHOOK, payload);
    
    console.log('n8n webhook response:', response.data);
    return { 
      success: true, 
      message: 'Email request sent to n8n',
      data: response.data
    };
  } catch (error) {
    console.error('Error calling n8n webhook:', error.message);
    return { 
      success: false, 
      message: `Failed to send email via n8n: ${error.message}`,
      error: error
    };
  }
}

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Gemini Bot running on port ${PORT}`);
  console.log(`🤖 Gemini AI: 2.0 Flash Enabled`);
  console.log(`🧪 Test UI available at: http://localhost:${PORT}/test-chat`);
  console.log(`📝 API Documentation:`);
  console.log(`   - POST /test-ai - Test AI responses`);
  console.log(`   - POST /test-webhook - Simulate WhatsApp webhook`);
  console.log(`   - GET /test-chat - Interactive chat UI for testing`);
});




