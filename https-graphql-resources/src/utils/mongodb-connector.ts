import { Db, MongoClient } from "mongodb";
import { getLoadedEnvVariables } from "./env-loader";


let getMongoDBConnection = async (): Promise<{ connection: Promise<MongoClient>, db: Promise<Db> }> => {
    var instance: { connection: Promise<MongoClient>, db: Promise<Db>, internalConnection: Promise<MongoClient | null> };

    getMongoDBConnection = async () => {
        if ((await instance.internalConnection.catch(err => null)) == null) {
            await checkConnectionAndReconnect();
        }

        return instance;
    }

    async function createConnection() {
        if (await instance) {
            return instance;
        }
        console.log("MongoDB constructor called");
        const { MONGO_DB_ENDPOINT, DB_NAME } = getLoadedEnvVariables();
        const client = new MongoClient(MONGO_DB_ENDPOINT);
        const connection = client.connect().catch(reason => {
            console.log("error in init connect", reason)
        }) as Promise<MongoClient>;
        let internalConnection: Promise<MongoClient | null> = connection;
        const db = connection?.then(connection => connection?.db(DB_NAME), error => {
            console.log("error in connection", error);
            client.close()
            internalConnection = Promise.resolve(null);
        }) as Promise<Db>
        instance = { connection: internalConnection as Promise<MongoClient>, db, internalConnection };
        return instance;
    }


    async function checkConnectionAndReconnect() {
        console.log("Reconnecting... Hopefully it works now");
        // It will retry to conenct for 5 minutes. This is to solve race conditions at initial connections
        return new Promise<void>(resolve => {
            let counter = 0;
            const intervalId = setInterval(async () => {
                if ((await instance.internalConnection.catch(err => null)) != null || counter > 15) {
                    console.log(counter <= 30 ? "Its working now!" : "Timed out retries...");
                    clearInterval(intervalId);
                    resolve();
                }
                console.log("Retries...")
                instance = await createConnection();
                counter++;
            }, 20 * 1000)
        })
    }
    return await createConnection();
}

export { getMongoDBConnection }