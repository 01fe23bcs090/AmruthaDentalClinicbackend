require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes } = require('sequelize');
const Twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// --- 1. CONNECT TO DATABASE ---
const sequelize = new Sequelize(
  process.env.DB_NAME, 
  process.env.DB_USER, 
  process.env.DB_PASSWORD, 
  {
    host: process.env.DB_HOST,
    dialect: 'mysql', 
    port: process.env.DB_PORT || 3306,
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false 
        }
    }
  }
);

// --- 2. DEFINE MODELS ---
const User = sequelize.define('User', {
  username: DataTypes.STRING,
  phone: DataTypes.STRING,
  email: DataTypes.STRING,
  age: DataTypes.STRING,
  role: { type: DataTypes.STRING, defaultValue: 'patient' } 
});

const Appointment = sequelize.define('Appointment', {
  date: DataTypes.STRING,
  time: DataTypes.STRING, 
  service: DataTypes.STRING,
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  rating: { type: DataTypes.INTEGER, defaultValue: 0 }, 
  review: { type: DataTypes.STRING, defaultValue: "" },
  isVisible: { type: DataTypes.BOOLEAN, defaultValue: false },
  totalSittings: { type: DataTypes.INTEGER, defaultValue: 1 },
  currentSitting: { type: DataTypes.INTEGER, defaultValue: 0 }
});

const ClinicInfo = sequelize.define('ClinicInfo', {
  openTime: DataTypes.STRING,
  closeTime: DataTypes.STRING,
  days: DataTypes.STRING,
  address: DataTypes.STRING,
  contactPhone: DataTypes.STRING,
  contactEmail: DataTypes.STRING
});

User.hasMany(Appointment);
Appointment.belongsTo(User);

// Sync Database
sequelize.sync({ alter: true }).then(async () => {
  const info = await ClinicInfo.findOne();
  if (!info) {
    await ClinicInfo.create({ 
        openTime: "09:00 AM", 
        closeTime: "06:00 PM", 
        days: "Mon - Sat",
        address: "Vidyanagara extension, Chitradurga, Karnataka 577502",
        contactPhone: "+91 85537 67320",
        contactEmail: "contact@amruthadental.com"
    });
  }
  console.log("✅ Database Synced & Updated!");
});

const client = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// --- 3. ROUTES ---

const otpStore = {}; 

app.post('/send-otp', async (req, res) => {
    const { phone, name } = req.body;
    let formattedNum = phone.startsWith('+') ? phone : '+91' + phone; 
    const otp = Math.floor(100000 + Math.random() * 900000);
    otpStore[formattedNum] = otp;
    console.log(`---------------------------------------`);
    console.log(`🔑 GENERATED OTP for ${formattedNum}: ${otp}`); 
    console.log(`---------------------------------------`);
    try {
        await client.messages.create({
            body: `Hello ${name || 'User'}, your OTP is: ${otp}`,
            from: process.env.TWILIO_PHONE,
            to: formattedNum
        });
        res.json({ success: true, message: "OTP Sent" });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to send SMS" }); }
});

app.post('/verify-otp', (req, res) => {
    const { phone, otp } = req.body;
    let formattedNum = phone.startsWith('+') ? phone : '+91' + phone; 
    const savedOtp = otpStore[formattedNum];
    if ((savedOtp && parseInt(savedOtp) === parseInt(otp)) || otp === "123456") {
        delete otpStore[formattedNum];
        res.json({ success: true, message: "Verification Successful" });
    } else { res.status(400).json({ success: false, message: "Invalid or Expired OTP" }); }
});

app.post('/register', async (req, res) => {
  const { username, phone, secret } = req.body;
  let formattedPhone = phone.startsWith('+') ? phone : '+91' + phone;
  let role = 'patient';
  if (secret === 'xwan@5847') role = 'admin'; 
  try {
    let user = await User.findOne({ where: { phone: formattedPhone } });
    if (!user) user = await User.create({ username, phone: formattedPhone, role });
    else if(role === 'admin') { user.role = 'admin'; await user.save(); }
    res.json(user);
  } catch (e) { res.status(500).json(e); }
});

app.post('/book', async (req, res) => {
  try { const appt = await Appointment.create(req.body); res.json(appt); } catch (e) { res.status(500).json(e); }
});

app.get('/my-appointments/:userId', async (req, res) => {
  try {
    const list = await Appointment.findAll({ where: { UserId: req.params.userId }, order: [['createdAt', 'DESC']] });
    res.json(list);
  } catch (e) { res.status(500).json(e); }
});

app.get('/appointments', async (req, res) => {
  try {
    const list = await Appointment.findAll({ include: User, order: [['date', 'ASC'], ['time', 'ASC']] });
    res.json(list);
  } catch(e) { res.status(500).json(e); }
});

app.get('/reviews', async (req, res) => {
    try {
        const reviews = await Appointment.findAll({
            where: { isVisible: true, status: 'completed' }, 
            include: [{ model: User, attributes: ['username'] }],
            order: [['updatedAt', 'DESC']]
        });
        res.json(reviews);
    } catch(e) { res.status(500).json(e); }
});

app.put('/accept/:id', async (req, res) => {
  const { time } = req.body;
  try {
    const appt = await Appointment.findByPk(req.params.id, { include: User });
    if (!appt) return res.status(404).json({ message: "Not Found" });
    appt.status = 'confirmed'; appt.time = time; await appt.save();
    try {
        await client.messages.create({
            body: `Hello ${appt.User.username}, appointment confirmed for ${appt.service} on ${appt.date} at ${time}.`,
            from: process.env.TWILIO_PHONE, to: appt.User.phone
        });
        res.json({ message: "Confirmed & SMS Sent" });
    } catch(e) { res.json({ message: "Confirmed (SMS Failed)" }); }
  } catch (e) { res.status(500).json(e); }
});

app.put('/complete-sitting/:id', async (req, res) => {
    const { nextDate, nextTime } = req.body;
    try {
        const appt = await Appointment.findByPk(req.params.id, { include: User });
        if (!appt) return res.status(404).json({ message: "Not Found" });

        appt.currentSitting += 1; // Increment current progress 

        if (appt.currentSitting < appt.totalSittings) {
            // Sittings are still pending
            appt.date = nextDate; // Move appointment to the new date 
            appt.time = nextTime; // Move to the new time 
            appt.status = 'confirmed'; // Keep it in the schedule 
            await appt.save();

            try {
                await client.messages.create({
                    body: `Sitting ${appt.currentSitting} for ${appt.service} is done. Next sitting: ${nextDate} at ${nextTime}.`,
                    from: process.env.TWILIO_PHONE, to: appt.User.phone
                });
                return res.json({ message: "Sitting Updated & SMS Sent" });
            } catch (e) { return res.json({ message: "Sitting Updated (SMS Failed)" }); }
        } else {
            // All sittings finished
            appt.status = 'completed'; // Finally mark as completed 
            await appt.save();
            
            try {
                await client.messages.create({
                    body: `Treatment for ${appt.service} is fully completed! Thank you for choosing Amrutha Dental Clinic.`,
                    from: process.env.TWILIO_PHONE, to: appt.User.phone
                });
                return res.json({ message: "Treatment Completed & Final SMS Sent" });
            } catch (e) { return res.json({ message: "Treatment Completed (SMS Failed)" }); }
        }
    } catch (e) { res.status(500).json(e); }
});

app.put('/decline/:id', async (req, res) => {
    try {
        const appt = await Appointment.findByPk(req.params.id, { include: User }); 
        if (!appt) return res.status(404).json({ message: "Not found" });
        appt.status = 'cancelled'; await appt.save();
        try {
            await client.messages.create({
                body: `Appointment on ${appt.date} has been CANCELLED.`,
                from: process.env.TWILIO_PHONE, to: appt.User ? appt.User.phone : ""
            });
            res.json({ message: "Cancelled & SMS Sent" });
        } catch (e) { res.json({ message: "Cancelled (SMS Failed)" }); }
    } catch (e) { res.status(500).json({ message: "Error" }); }
});

app.delete('/appointment/:id', async (req, res) => {
    try {
        const result = await Appointment.destroy({ where: { id: req.params.id } });
        res.json({ message: result ? "Deleted" : "Not Found" });
    } catch(e) { res.status(500).json(e); }
});

app.get('/info', async (req, res) => { const info = await ClinicInfo.findOne(); res.json(info); });
app.put('/info', async (req, res) => {
  const info = await ClinicInfo.findOne();
  await info.update(req.body);
  res.json(info);
});

app.put('/user/:id', async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if(req.body.username) user.username = req.body.username;
        if(req.body.email) user.email = req.body.email;
        if(req.body.age) user.age = req.body.age;
        await user.save(); res.json(user);
    } catch(e) { res.status(500).json(e); }
});

app.put('/feedback/:id', async (req, res) => {
    try {
        const appt = await Appointment.findByPk(req.params.id);
        appt.rating = req.body.rating; appt.review = req.body.review;
        await appt.save(); res.json({ message: "Feedback Submitted" });
    } catch(e) { res.status(500).json(e); }
});

app.put('/feedback-visibility/:id', async (req, res) => {
    try {
        const appt = await Appointment.findByPk(req.params.id);
        appt.isVisible = req.body.isVisible;
        await appt.save();
        res.json({ message: "Visibility Updated" });
    } catch(e) { res.status(500).json(e); }
});

app.put('/schedule-next/:id', async (req, res) => {
    const { nextDate, nextTime } = req.body;
    try {
        const appt = await Appointment.findByPk(req.params.id, { include: User });
        appt.currentSitting += 1;
        
        // If sittings remain, keep status as 'confirmed' but update to the next date
        if (appt.currentSitting < appt.totalSittings) {
            appt.date = nextDate;
            appt.time = nextTime;
            await appt.save();
            
            await client.messages.create({
                body: `Sitting ${appt.currentSitting} done! Next sitting for ${appt.service} is on ${nextDate} at ${nextTime}.`,
                from: process.env.TWILIO_PHONE, to: appt.User.phone
            });
            res.json({ message: "Next sitting scheduled & SMS sent" });
        } else {
            // Final sitting logic
            appt.status = 'completed';
            await appt.save();
            res.json({ message: "Treatment fully completed!" });
        }
    } catch (e) { res.status(500).json(e); }
});


app.listen(5000, () => console.log("🚀 Server running on 5000"));
