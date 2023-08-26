import { CORSOptions } from "graphql-yoga/typings/types";


function corsRequestHandler(request: Request): CORSOptions {
    const origin = request.headers.get('origin') ?? undefined;

    const isValidOrigin = origin == null || origin === 'https://allotr.eu' || /^https:\/\/.+?\.allotr\.eu$/gm.test(origin);

    return {
        origin: isValidOrigin ? origin : undefined,
        credentials: true,
        methods: ['POST']
    }
}


export { corsRequestHandler }