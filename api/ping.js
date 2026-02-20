export default async function handler(req, res) {
    res.status(200).json({ 
        clientTime: req.body?.time || Date.now(),
        serverTime: Date.now() 
    });
}
