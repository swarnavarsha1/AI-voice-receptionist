import express from 'express';
import axios from 'axios';
import 'dotenv/config';
import { createUltravoxCall } from '../ultravox-utils.js';
import { ULTRAVOX_CALL_CONFIG } from '../ultravox-config.js';

const router = express.Router();

/**
 * Helper to call PBXware API
 * All requests use the base URL and API Key from env
 */
async function pbxRequest(action, params = {}) {
  const url = process.env.PBXWARE_API_URL; // e.g., https://your-pbx.com/api
  try {
    const response = await axios.get(url, {
      params: {
        apikey: process.env.PBXWARE_API_KEY,
        action: action,
        ...params
      }
    });
    return response.data;
  } catch (error) {
    console.error(`PBXware API Error (${action}):`, error.message);
    throw error;
  }
}

// 1. OUTBOUND CALLS
async function makeOutboundCall({ phoneNumber, systemPrompt, selectedTools }) {
  console.log(`Initiating outbound SIP call to ${phoneNumber}...`);

  // Configure Ultravox to dial OUT via SIP to PBXware
  const uvCallConfig = {
    systemPrompt: systemPrompt || ULTRAVOX_CALL_CONFIG.systemPrompt,
    model: ULTRAVOX_CALL_CONFIG.model,
    voice: ULTRAVOX_CALL_CONFIG.voice,
    selectedTools: selectedTools || ULTRAVOX_CALL_CONFIG.selectedTools,
    firstSpeaker: 'FIRST_SPEAKER_USER', // Usually better for outbound calls
    medium: {
      sip: {
        outgoing: {
          // PBXware sees this as a call FROM the AI extension TO the customer
          // Format: sip:TARGET_NUMBER@PBX_DOMAIN
          to: `sip:${phoneNumber}@${process.env.PBXWARE_SIP_DOMAIN}`,
          from: process.env.AI_SIP_USERNAME,
          username: process.env.AI_SIP_USERNAME,
          password: process.env.AI_SIP_PASSWORD
        }
      }
    }
  };

  // This creates the call immediately; Ultravox starts dialing SIP
  const { callId, joinUrl } = await createUltravoxCall(uvCallConfig);
  console.log('Ultravox SIP Call initiated:', callId);
  return { callId };
}

// 2. TRANSFER LOGIC
router.post('/transferCall', async (req, res) => {
  const { firstName, lastName, contactType } = req.body;
  const db = req.app.locals.db;

  console.log(`Transfer request for ${firstName} ${lastName}`);

  try {
    // 1. Lookup Student Phone Number
    const student = db.getStudentByName(firstName, lastName);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const targetNumber = contactType === 'emergency' ? student.emergency_contact_phone : student.phone;
    if (!targetNumber) {
      return res.status(400).json({ error: 'No phone number found' });
    }

    console.log(`Transfer target found: ${targetNumber}`);

    // 2. Find the Active Channel in PBXware
    // We query PBXware to see who is currently connected to our AI Agent's extension.
    // 'monitor.channels' is the standard action, but check your PBX docs if it fails.
    const monitorData = await pbxRequest('monitor.channels');
    
    // Handle potential response formats (XML converted to JSON, or direct JSON)
    // Adjust 'channels' access based on your actual PBXware API response structure
    const channels = Array.isArray(monitorData) ? monitorData : (monitorData.channels || []);

    const activeChannel = channels.find(ch => 
      // We look for a channel where our AI Extension is either the Source or Destination
      ch.src === process.env.AI_SIP_USERNAME || ch.dst === process.env.AI_SIP_USERNAME
    );

    if (!activeChannel) {
      throw new Error('Could not find active PBXware channel for AI extension');
    }

    // 3. Execute Transfer
    // We instruct PBXware to redirect that channel to the new number.
    console.log(`Transferring PBX Channel ${activeChannel.channel} to ${targetNumber}`);
    
    // Note: 'call.transfer' is a common alias; if it fails, try 'asterisk.manager.action' with command='Redirect'
    await pbxRequest('call.transfer', {
      channel: activeChannel.channel,
      destination: targetNumber
    });

    res.json({ status: 'success', message: 'Transfer initiated via PBXware' });

  } catch (error) {
    console.error('Transfer failed:', error);
    res.status(500).json({ error: 'Transfer failed', details: error.message });
  }
});

// Handle incoming calls
// Handle incoming calls from PBXware
router.post('/incoming', async (req, res) => {
  try {
    console.log('Incoming call received from PBXware');
    console.log('Request body:', req.body);
    
    // Extract caller information from PBXware webhook
    const callerNumber = req.body.from || req.body.CallerID || 'Unknown';
    const callSid = req.body.callSid || req.body.uniqueid;
    
    // Create Ultravox call configured to receive incoming SIP
    const uvCallConfig = {
      systemPrompt: ULTRAVOX_CALL_CONFIG.systemPrompt,
      model: ULTRAVOX_CALL_CONFIG.model,
      voice: ULTRAVOX_CALL_CONFIG.voice,
      selectedTools: ULTRAVOX_CALL_CONFIG.selectedTools,
      firstSpeaker: 'FIRST_SPEAKER_AGENT',
      medium: {
        sip: {
          // Configure for INCOMING SIP call
          incoming: {
            // PBXware will connect TO this SIP endpoint
            username: process.env.AI_SIP_USERNAME,
            password: process.env.AI_SIP_PASSWORD
          }
        }
      }
    };
    
    const { joinUrl, callId } = await createUltravoxCall(uvCallConfig);
    
    console.log('Ultravox call created:', callId);
    console.log('Caller:', callerNumber);
    
    // Store call mapping if you need it for transfers later
    // activeCalls.set(callId, { pbxCallSid: callSid, from: callerNumber });
    
    // PBXware expects specific response format
    // This tells PBXware how to bridge the call to Ultravox
    res.json({
      status: 'success',
      callId: callId,
      // PBXware needs SIP URI to connect to
      sipUri: `sip:${process.env.AI_SIP_USERNAME}@${process.env.PBXWARE_SIP_DOMAIN}`
    });
    
  } catch (error) {
    console.error('Error handling incoming call:', error);
    res.status(500).json({ 
      status: 'error',
      error: error.message 
    });
  }
});


// 3. COUNTRY INFO (Utility)
router.post('/countryInfo', async (req, res) => {
  const { countryName } = req.body;
  console.log(`Processing country info request for: ${countryName}`);

  try {
    // FIX: Using axios instead of fetch for compatibility
    const response = await axios.get(`https://restcountries.com/v3.1/name/${countryName}`);
    
    // Axios throws on 404/500, so if we are here, it worked.
    const data = response.data;
    const country = data[0]; // Take first match

    // Extract fields
    const name = country.name?.common || countryName;
    const region = country.region || "unknown region";
    const capital = (country.capital && country.capital.length > 0) ? country.capital[0] : "no official capital";

    // Format Population
    const rawPop = country.population || 0;
    let popStr = rawPop.toLocaleString();
    if (rawPop >= 1_000_000) {
      popStr = `${(rawPop / 1_000_000).toFixed(1)} million`;
    }

    // Extract Currency
    let currencyName = "unknown currency";
    if (country.currencies) {
      const currencyValues = Object.values(country.currencies);
      if (currencyValues.length > 0) {
        currencyName = currencyValues[0].name;
      }
    }

    const spokenResponse = `${name} is a country in ${region}. Its capital is ${capital}. The population is about ${popStr}, and the official currency is the ${currencyName}.`;
    console.log(`Generated response: ${spokenResponse}`);

    res.json({ result: spokenResponse });

  } catch (error) {
    console.error('Error fetching country info:', error.message);
    if (error.response && error.response.status === 404) {
         return res.json({ result: `I'm sorry, I couldn't find any information for ${countryName}.` });
    }
    res.status(500).json({ result: "I'm having trouble accessing the country database right now." });
  }
});

export { router, makeOutboundCall };
