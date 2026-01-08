import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { MODE } from '../../Interface'
import chatflowService from '../../services/chatflows'
import { utilBuildChatflow } from '../../utils/buildChatflow'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

// Send input message and get prediction result (Internal)
const createInternalPrediction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = req.user?.activeWorkspaceId

        const chatflow = await chatflowService.getChatflowById(req.params.id, workspaceId)
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${req.params.id} not found`)
        }

        if (req.body.streaming || req.body.streaming === 'true') {
            createAndStreamInternalPrediction(req, res, next)
            return
        } else {
            const apiResponse = await utilBuildChatflow(req, true)
            if (apiResponse) return res.json(apiResponse)
        }
    } catch (error) {
        next(error)
    }
}

// Send input message and stream prediction result using SSE (Internal)
const createAndStreamInternalPrediction = async (req: Request, res: Response, next: NextFunction) => {
    const chatId = req.body.chatId
    const sseStreamer = getRunningExpressApp().sseStreamer

    let heartbeat: NodeJS.Timeout | undefined

    try {
        sseStreamer.addClient(chatId, res)
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no') //nginx config: https://serverfault.com/a/801629
        res.flushHeaders()

        // Heartbeat for SSE: keeps the connection active through proxies / ALB idle timeouts.
        // Default: 15s. Override with SSE_HEARTBEAT_MS env var.
        const heartbeatMs = Number.parseInt(process.env.SSE_HEARTBEAT_MS || '15000', 10)
        if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
            const sendHeartbeat = () => {
                try {
                    // SSE comment line - ignored by EventSource clients, but counts as traffic.
                    res.write(`: heartbeat ${Date.now()}\n\n`)
                    // Some Express setups expose res.flush() via compression middleware.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const anyRes = res as any
                    if (typeof anyRes.flush === 'function') anyRes.flush()
                } catch (e) {
                    if (heartbeat) clearInterval(heartbeat)
                }
            }

            heartbeat = setInterval(sendHeartbeat, heartbeatMs)

            // Stop heartbeats when client disconnects.
            req.on('close', () => {
                if (heartbeat) clearInterval(heartbeat)
            })
        }

        if (process.env.MODE === MODE.QUEUE) {
            getRunningExpressApp().redisSubscriber.subscribe(chatId)
        }

        const apiResponse = await utilBuildChatflow(req, true)
        sseStreamer.streamMetadataEvent(apiResponse.chatId, apiResponse)
    } catch (error) {
        if (chatId) {
            sseStreamer.streamErrorEvent(chatId, getErrorMessage(error))
        }
        next(error)
    } finally {
        if (heartbeat) clearInterval(heartbeat)
        sseStreamer.removeClient(chatId)
    }
}
export default {
    createInternalPrediction
}

