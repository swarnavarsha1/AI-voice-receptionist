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
const activeCalls = new Map();

async function transferActiveCall(ultravoxCallId, targetNumber) {
    try {
        const callData = activeCalls.get(ultravoxCallId);
        if (!callData || !callData.twilioCallSid) {
            throw new Error('Call not found or invalid CallSid');
        }

        // First create a new TwiML to handle the transfer
        const twiml = new twilio.twiml.VoiceResponse();
        const finalDestination = targetNumber || process.env.DESTINATION_PHONE_NUMBER;
        console.log(`Transferring call ${ultravoxCallId} to ${finalDestination}`);
        
        twiml.dial().number(finalDestination);

        const updatedCall = await client.calls(callData.twilioCallSid)
            .update({ twiml: twiml.toString() });

        return {
            status: 'success',
            message: 'Call transfer initiated',
            callDetails: updatedCall
        };

    } catch (error) {
        console.error('Error transferring call:', error);
        throw {
            status: 'error',
            message: 'Failed to transfer call',
            error: error.message
        };
    }
}

async function makeOutboundCall({ phoneNumber, systemPrompt, selectedTools }) {
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
        type: 'outbound'
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
      
      activeCalls.set(response.callId, {
        twilioCallSid,
        type: 'inbound'
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
    const db = req.app.locals.db; // Access the DB instance

    console.log(`Transfer request for ${firstName} ${lastName} (${contactType})`);

    try {
        // Step A: Lookup the student
        let targetNumber = null;
        
        if (firstName && lastName) {
            const student = db.getStudentByName(firstName, lastName);
            if (student) {
                if (contactType === 'emergency') {
                    targetNumber = student.emergency_contact_phone;
                } else {
                    targetNumber = student.phone;
                }
            } else {
                console.warn(`Student ${firstName} ${lastName} not found.`);
            }
        }

        // Step B: Transfer (will fall back to default number if targetNumber is null)
        const result = await transferActiveCall(callId, targetNumber);
        res.json(result);

    } catch (error) {
        console.error('Transfer failed:', error);
        res.status(500).json({ error: error.message });
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

export { router, makeOutboundCall };

