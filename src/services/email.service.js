const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

exports.sendVerificationEmail = async (email, name, token) => {
  const verifyURL = `${process.env.FRONTEND_URL || "http://localhost:3000"}/verify-email/${token}`;

  await transporter.sendMail({
    from: `"Sanskriti Dashboard" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Verify your Sanskriti seller account",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: auto; padding: 32px;">
        <h2 style="color: #1a1a1a">Welcome, ${name}!</h2>
        <p style="color: #444">Click the button below to verify your email and activate your seller account.</p>
        <a href="${verifyURL}"
           style="display:inline-block;margin-top:16px;padding:12px 28px;background:#534AB7;color:#fff;border-radius:8px;text-decoration:none;font-weight:500">
          Verify Email
        </a>
        <p style="color:#888;font-size:13px;margin-top:24px">This link expires in 24 hours. If you did not register, ignore this email.</p>
      </div>
    `,
  });
};

exports.sendWelcomeEmail = async (email, name) => {
  await transporter.sendMail({
    from: `"Sanskriti Dashboard" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your Sanskriti seller account is active",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: auto; padding: 32px;">
        <h2>You're verified, ${name}!</h2>
        <p>Your seller account is now active. Log in to your dashboard to get started.</p>
      </div>
    `,
  });
};
exports.sendPasswordResetEmail = async (email, name, resetURL) => {
  await transporter.sendMail({
    from: `"Sanskriti Dashboard" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Reset your Sanskriti password",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: auto; padding: 32px;">
        <h2 style="color: #1a1a1a">Password Reset</h2>
        <p style="color: #444">Hi ${name}, click the button below to reset your password.</p>
        <p style="color: #888; font-size: 13px;">This link expires in <strong>10 minutes</strong>.</p>
        <a href="${resetURL}"
           style="display:inline-block;margin-top:16px;padding:12px 28px;background:#E24B4A;color:#fff;border-radius:8px;text-decoration:none;font-weight:500">
          Reset Password
        </a>
        <p style="color:#888;font-size:12px;margin-top:24px">
          If you didn't request this, ignore this email. Your password won't change.
        </p>
      </div>
    `,
  });
};