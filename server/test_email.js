const { sendEmail } = require('./emailService');

async function test() {
  console.log('Sending test email...');
  const success = await sendEmail(
    'infodialaiagent@gmail.com', // To
    'Brevo Test Email', // Subject
    'If you are reading this, Brevo is successfully connected to your Node.js app!', // Text body
    '<b>If you are reading this, Brevo is successfully connected to your Node.js app!</b>' // HTML body
  );
  
  if (success) {
    console.log('Test email sent successfully!');
  } else {
    console.log('Failed to send test email.');
  }
}

test();
