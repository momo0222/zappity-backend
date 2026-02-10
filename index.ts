import express from 'express';
import { Server } from "socket.io"
import { createServer } from 'http';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

const app = express();
app.use(cors());
app.use(express.json());
const prisma = new PrismaClient();

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: process.env.FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true
    }
});


function formatVotes(options: {label: string, _count: {votes: number}}[]){
    const formattedVotes: Record<string, number> = {};
    options.forEach((option) => {
        formattedVotes[option.label] = option._count.votes;
    })
    return formattedVotes;
}

app.post("/create-session", async (req, res) => {
   const {title, options} = req.body;

   const poll = await prisma.poll.create({
        data: {
            id: nanoid(),
            title,
            options: {
                create: options.map((label: string) => ({label}))
            }
        },
        include: { options: true }
   });

   res.status(201).json({ sessionId: poll.id });
});

app.post("/join-session", (req, res) => {
    const voterToken = randomUUID();

    res.json({ voterToken })
})

app.get("/session/:id", async(req, res) => {
   const session = await prisma.poll.findUnique({
        where: {
            id: req.params.id
        },
        include: {
            options: {
                include: {
                    _count: {select: {votes: true}}
                }
            }
        }
    });

    if(!session) return res.status(404).send("Not found");
    console.log(session.options)
    res.status(200).json({title: session.title, votes: formatVotes(session.options)});
});

app.post("/session/:id/vote", async (req, res) => {
     console.log("vote endpoint hit");
    const session = req.params.id;
    const {option, voterToken} = req.body;
    if(!voterToken){
        return res.status(400).send("Missing user token")
    }
    const opt = await prisma.option.findFirst({
        where: {
            pollId: session,
            label: option
        }
    })
    if(!opt){
        return res.status(400).send("Invalid option");
    }
    try {
        await prisma.vote.create({
            data: {
                pollId: session,
                optionId: opt.id,
                voterToken
            }
        })
    }catch (e){
        //unique constraint on votertoken
        return res.status(409).send("Already voted");
    }
    const options = await prisma.option.findMany({
        where: { pollId: session },
        select: { id: true, label: true }
    }); // find all options

    const votes = await prisma.vote.groupBy({
        by: ["optionId"],
        where: {pollId: session},
        _count: {optionId: true}
    })// group all votes

    const countsByOptionId = Object.fromEntries(
        votes.map(v => [v.optionId, v._count.optionId])
    );

    const formatted = Object.fromEntries(
        options.map(o => [o.label, countsByOptionId[o.id] ?? 0])
    )
    console.log(formatted);
    io.to(session).emit("session-updated", formatted);
    
    res.status(200).json({ok: true})
})

app.get("/health", (_, res) => {
    res.json({ ok: true})
});

io.on("connection", (socket) => {
    console.log("new client connected: ", socket.id);

    socket.on("join-session", async (sessionId: string) => {
        try{
            const poll = await prisma.poll.findUnique({
            where: {id: sessionId},
            select: {id: true}
            })
            if(!poll){
                socket.emit("session-error", "Session not found");
                return;
            }
            socket.join(sessionId);
            console.log(`Socket ${socket.id} joined session ${sessionId}`);
        }catch(e){
            socket.emit("session-error", "Server error");
        }

    });
    socket.on("disconnect", (reason) => {
        console.log("client disconnected:", socket.id, reason);
    });
});

httpServer.listen(process.env.PORT || 3001, () => {
    console.log("Server running on 3001")
});