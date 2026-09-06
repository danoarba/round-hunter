const nodemailer = require('nodemailer');
require('dotenv').config();

// Create a reusable transporter using Brevo SMTP
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.BREVO_SMTP_USER, // Your Brevo Login Email
    pass: process.env.BREVO_SMTP_PASS, // Your Brevo Master Password or SMTP Key
  },
});

/**
 * Send an email using Brevo
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} text - Email body in plain text
 * @param {string} html - Email body in HTML
 */
async function sendEmail(to, subject, text, html) {
  try {
    const info = await transporter.sendMail({
      from: '"Dial AI Agent" <danial@dialaiagent.info>', // Sender address
      to: to,
      subject: subject,
      text: text,
      html: html,
    });
    console.log('Message sent: %s', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

module.exports = {
  sendEmail,
};
