import express from 'express';
import twilio from 'twilio';
import 'dotenv/config';
import { createUltravoxCall } from '../ultravox-utils.js';
import { ULTRAVOX_CALL_CONFIG } from '../ultravox-config.js';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const destinationNumber = process.env.DESTINATION_PHONE_NUMBER;
const router = express.Router();

// Hack: Dictionary to store Twilio CallSid and Ultravox Call ID mapping
// In production you will want to replace this with something more durable
//const activeCalls = new Map();
export const activeCalls = new Map();

function guessTimeZoneFromTwilioWebhook(body) {
  // Best practical fallback (CCC is Seattle)
  return process.env.DEFAULT_TIME_ZONE || "America/Los_Angeles";
}


async function transferActiveCall(ultravoxCallId, targetNumber) {
    try {
        const callData = activeCalls.get(ultravoxCallId);
        if (!callData || !callData.twilioCallSid) {
            throw new Error('Call not found or invalid CallSid');
        }
        // Use the target number or fall back to default
        const finalDestination = targetNumber || process.env.DESTINATION_PHONE_NUMBER;
        console.log(`Transferring call ${ultravoxCallId} to ${finalDestination}`);
        console.log(`Twilio CallSid: ${callData.twilioCallSid}`);
        // Create TwiML for the transfer
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('Please hold while I transfer your call');
        const dial = twiml.dial({
            callerId: process.env.TWILIO_PHONE_NUMBER // Must be your verified Twilio number
        });
        dial.number(finalDestination);
        console.log('Generated TwiML:', twiml.toString());
        // Update the active call with new TwiML
        const updatedCall = await client.calls(callData.twilioCallSid)
            .update({ twiml: twiml.toString() });
        console.log('Transfer initiated. Call status:', updatedCall.status);
        return {
            status: 'success',
            message: 'Call transfer initiated',
            callDetails: updatedCall
        };
    } 
    catch (error) {
        console.error('Error transferring call:', error);
        throw {
            status: 'error',
            message: 'Failed to transfer call',
            error: error.message
        };
    }
}

async function makeOutboundCall({ phoneNumber, systemPrompt, selectedTools, timeZone }) {
    try {
      console.log('Creating outbound call...');
      
      const uvCallConfig = {
        systemPrompt,
        voice: 'Mark',
        selectedTools,
        temperature: 0.3,
        firstSpeaker: 'FIRST_SPEAKER_USER',
        medium: { "twilio": {} }
      };
  
      const { joinUrl, callId } = await createUltravoxCall(uvCallConfig);
      console.log('Got joinUrl:', joinUrl);
  
      const call = await client.calls.create({
        twiml: `<Response><Connect><Stream url="${joinUrl}"/></Connect></Response>`,
        to: phoneNumber,  // Consider hardcoding your own number here for local testing
        from: twilioNumber
      });
  
      // Store the mapping
      activeCalls.set(callId, {
        twilioCallSid: call.sid,
        type: 'outbound',
        to: phoneNumber,
        timeZone: timeZone || process.env.DEFAULT_TIME_ZONE || "America/Los_Angeles",
      });
  
      return { callId, twilioCallSid: call.sid };
    } catch (error) {
      console.error('Error making outbound call:', error);
      throw error;
    }
}

// Handle incoming calls from Twilio
router.post('/incoming', async (req, res) => {
    try {
      console.log('Incoming call received');
      const twilioCallSid = req.body.CallSid;
      
      const response = await createUltravoxCall(ULTRAVOX_CALL_CONFIG);
      
      const timeZone = guessTimeZoneFromTwilioWebhook(req.body);

      activeCalls.set(response.callId, {
        twilioCallSid,
        type: 'inbound',
        from: req.body.From,
        timeZone,
      });

      const twiml = new twilio.twiml.VoiceResponse();
      const connect = twiml.connect();
      connect.stream({
        url: response.joinUrl,
        name: 'ultravox'
      });
  
      res.type('text/xml');
      res.send(twiml.toString());
    } catch (error) {
      console.error('Error handling incoming call:', error);
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say('Sorry, there was an error connecting your call.');
      res.type('text/xml');
      res.send(twiml.toString());
    }
});
  
router.post('/transferCall', async (req, res) => {
    const { callId, firstName, lastName, contactType } = req.body;
    const db = req.app.locals.db;
    console.log(`Transfer request for ${firstName} ${lastName} (${contactType})`);
    try {
        let targetNumber = null;
        if (firstName && lastName) {
            const student = db.getStudentByName(firstName, lastName);
            if (student) {
                // Get the appropriate phone number
                if (contactType === 'emergency') {
                    targetNumber = student.emergency_contact_phone;
                } else {
                    targetNumber = student.phone;
                }
                console.log(`Found student: ${firstName} ${lastName}`);
                console.log(`Target phone: ${targetNumber}`);
                console.log(`Contact type: ${contactType}`);
            } else {
                console.warn(`Student ${firstName} ${lastName} not found in database`);
                return res.status(404).json({ 
                    error: 'Student not found',
                    message: `No student found with name ${firstName} ${lastName}` 
                });
            }
        }
        // Validate we have a phone number
        if (!targetNumber) {
            console.error('No target phone number available');
            return res.status(400).json({ 
                error: 'No phone number available',
                message: `No ${contactType} phone number found for ${firstName} ${lastName}` 
            });
        }
        // Initiate the transfer
        const result = await transferActiveCall(callId, targetNumber);
        res.json(result);
    } 
    catch (error) {
        console.error('Transfer failed:', error);
        res.status(500).json({ 
            error: 'Transfer failed',
            message: error.message 
        });
    }
});

// Note: not used for the agent...for testing purposes
router.post('/makeOutboundCall', async (req, res) => {
    try {
        const { phoneNumber, systemPrompt, selectedTools } = req.body;
        const result = await makeOutboundCall({ phoneNumber, systemPrompt, selectedTools });
        res.json(result);
    } catch (error) {
        console.error('Error initiating outbound call:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route to handle country information requests
router.post('/countryInfo', async (req, res) => {
  const { countryName } = req.body;
  console.log(`Processing country info request for: ${countryName}`);

  try {
    // 1. Call the REST Countries API
    const response = await fetch(`https://restcountries.com/v3.1/name/${countryName}`);

    if (!response.ok) {
      console.warn(`Country API returned status: ${response.status}`);
      return res.json({
        result: `I'm sorry, I couldn't find any information for ${countryName}.`
      });
    }

    const data = await response.json();
    const country = data[0]; // The API returns an array, take the first match

    // 2. Extract specific fields based on your requirements
    const name = country.name?.common || countryName;
    const region = country.region || "unknown region";
    
    // Capital is an array (e.g., ["Berlin"])
    const capital = (country.capital && country.capital.length > 0) 
      ? country.capital[0] 
      : "no official capital";

    // Format Population: Convert 83240525 -> "83.2 million"
    const rawPop = country.population || 0;
    let popStr = rawPop.toLocaleString();
    if (rawPop >= 1_000_000) {
      popStr = `${(rawPop / 1_000_000).toFixed(1)} million`;
    }

    // Extract Currency: Handle dynamic keys like "EUR" or "USD"
    // structure is { "EUR": { "name": "Euro", ... } }
    let currencyName = "unknown currency";
    if (country.currencies) {
      const currencyValues = Object.values(country.currencies);
      if (currencyValues.length > 0) {
        currencyName = currencyValues[0].name;
      }
    }

    // 3. Construct the voice-friendly sentence
    // Example: "Germany is a country in Europe. Its capital is Berlin. The population is about 83 million, and the official currency is the Euro."
    const spokenResponse = `${name} is a country in ${region}. Its capital is ${capital}. The population is about ${popStr}, and the official currency is the ${currencyName}.`;

    console.log(`Generated response: ${spokenResponse}`);

    // Return the result for Ultravox to speak
    res.json({ result: spokenResponse });

  } catch (error) {
    console.error('Error fetching country info:', error);
    res.status(500).json({
      result: "I'm having trouble accessing the country database right now."
    });
  }
});

export { router, makeOutboundCall };

