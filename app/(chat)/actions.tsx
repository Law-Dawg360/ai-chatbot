'use server'

import { kv } from '@vercel/kv'
import {
  OpenAIStream,
  experimental_StreamingReactResponse,
  experimental_StreamData,
  type Message
} from 'ai'
import OpenAI from 'openai'

import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'
import {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam
} from 'openai/resources'

import { DataView } from '@/components/data-view'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const functions: ChatCompletionCreateParams.Function[] = [
  {
    name: 'get_current_weather',
    description: 'Get the current weather',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The city and state, e.g. San Francisco, CA'
        },
        format: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description:
            'The temperature unit to use. Infer this from the users location.'
        }
      },
      required: ['location', 'format']
    }
  },
  {
    name: 'create_image',
    description: 'Create an image for the given description',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of what the image should be.'
        }
      },
      required: ['description']
    }
  }
]

export async function handleChat(
  meta: {
    id: string
    previewToken?: string
  },
  chat: {
    messages: Message[]
  }
) {
  const userId = (await auth())?.user.id

  if (!userId) {
    return new Response('Unauthorized', {
      status: 401
    })
  }

  if (meta.previewToken) {
    openai.apiKey = meta.previewToken
  }

  const data = new experimental_StreamData()
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: chat.messages.map(m => ({
      content: m.content,
      role: m.role
    })) as ChatCompletionMessageParam[],
    functions,
    stream: true
  })

  const stream = OpenAIStream(response, {
    onFinal() {
      data.close()
    },
    async experimental_onFunctionCall({ name, arguments: args }) {
      switch (name) {
        case 'get_current_weather': {
          // fake function call result:
          data.append({
            type: 'weather',
            location: args.location as string,
            format: args.format as string,
            temperature: Math.floor(Math.random() * 60) - 20
          })
          return
        }

        case 'create_image': {
          const { description } = args

          // generate image
          const response = await openai.images.generate({
            model: 'dall-e-2',
            prompt: `${description}`,
            size: '256x256',
            response_format: 'url'
          })

          data.append({
            type: 'image',
            url: response.data[0].url!
          })

          return
        }
      }

      return undefined
    },
    experimental_streamData: true
  })

  return new experimental_StreamingReactResponse(stream, {
    data,
    async ui({ content, data }) {
      // store chat including the data from the function call:
      const title = chat.messages[0].content.substring(0, 100)
      const id = meta.id ?? nanoid()
      const createdAt = Date.now()
      const path = `/chat/${id}`
      const payload = {
        id,
        title,
        userId,
        createdAt,
        path,
        messages: [
          ...chat.messages,
          {
            data, // store data from function call, so UI components can be reconstructed
            content,
            role: 'assistant'
          }
        ]
      }

      await kv.hmset(`chat:${id}`, payload)
      await kv.zadd(`user:chat:${userId}`, {
        score: createdAt,
        member: `chat:${id}`
      })

      return <DataView data={data} content={content} />
    }
  })
}
