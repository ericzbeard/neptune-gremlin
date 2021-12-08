const gremlin = require("gremlin")
const async = require("async")
const {traversal} = gremlin.process.AnonymousTraversalSource
const {DriverRemoteConnection} = gremlin.driver
const util = require("util")
const aws4 = require("aws4")

/**
 * Represents a connection to Neptune's gremlin endpoint.
 * 
 * TODO: Publish this to its own repo and NPM once it's stable.
 * TODO: Get a single node, get a single edge
 * TODO: A-B-C queries. node label/props - edge label/props - node label/props
 *       e.g. person/title=Manager - manages - person/title=Engineer
 *            person/name=Eric - owns/leased=true - car/color=Blue
 * 
 * Connect to Neptune:
 * 
 * ```Javascript
 * const gremlin = require("./aws-neptune-gremlin")
 * 
 * // Get configuration values from the environment
 * const host = process.env.NEPTUNE_ENDPOINT
 * const port = process.env.NEPTUNE_PORT
 * const useIam = process.env.USE_IAM === "true"
 * 
 * // Create a new connection to the Neptune database
 * const connection = new gremlin.Connection(host, port, useIam)
 * await connection.connect()
 * ```
 * 
 * Save a node (vertex):
 * 
 * ```Javascript
 * const node1 = {
 *     "unique-id-1",
 *     properties: {
 *         name: "Test Node",
 *         a: "A",
 *         b: "B",
 *     },
 *     labels: ["label1", "label2"],
 * }
 * await connection.saveNode(node1)
 * ```
 * 
 * Run a custom traversal:
 * 
 * ```Javascript
 * const f = (g) => {
 *     return await g.V()
 *         .has("person", "name", "Eric")
 *         .bothE().bothV().dedup()
 *         .valueMap(true).toList()
 * }
 * const result = await connection.query(f)
 * ```
 * 
 * @see https://docs.aws.amazon.com/neptune/latest/userguide/lambda-functions-examples.html
 */
class Connection {

    /**
     * Initialize the connection instance.
     * 
     * @param {String} host 
     * @param {number} port 
     * @param {boolean} useIam 
     */
    constructor(host, port, useIam) {
        this.host = host
        this.port = port
        this.useIam = useIam
        this.connection = null
    }

    /**
     * Connect to the endpoint.
     */
    async connect() {

        const path = "/gremlin"

        const url = `wss://${this.host}:${this.port}${path}`
        const headers = this.useIam ? getHeaders(this.host, this.port, {}, path) : {}

        console.info("url: ", url)
        console.info("headers: ", headers)

        this.connection = new DriverRemoteConnection(
            url,
            {
                mimeType: "application/vnd.gremlin-v2.0+json",
                headers,
            })

        this.connection._client._connection.on("close", (code, message) => {
            console.info(`close - ${code} ${message}`)
            if (code == 1006) {
                console.error("Connection closed prematurely")
                throw new Error("Connection closed prematurely")
            }
        })

    }

    /**
     * Query the endpoint.
     * 
     * For simple use cases, use the provided helper functions `saveNode`, `saveEdge`, etc.
     * 
     * @param {Function} f - Your query function with signature f(g), where `g` is
     * the gremlin traversal source.
     */
    async query(f) {

        console.log("About to get traversal")
        let g = traversal().withRemote(this.connection)

        console.log("About to start async retry loop")
        return async.retry(
            {
                times: 5,
                interval: 1000,
                errorFilter: function (err) {

                    // Add filters here to determine whether error can be retried
                    console.warn("Determining whether retriable error: " + err.message)

                    // Check for connection issues
                    if (err.message.startsWith("WebSocket is not open")) {
                        console.warn("Reopening connection")
                        this.connection.close()
                        this.connect()
                        g = traversal().withRemote(this.connection)
                        return true
                    }

                    // Check for ConcurrentModificationException
                    if (err.message.includes("ConcurrentModificationException")) {
                        console.warn("Retrying query because of ConcurrentModificationException")
                        return true
                    }

                    // Check for ReadOnlyViolationException
                    if (err.message.includes("ReadOnlyViolationException")) {
                        console.warn("Retrying query because of ReadOnlyViolationException")
                        return true
                    }

                    return false
                },

            },
            async () => {
                console.log("About to call the query function")
                return await f(g)
            })
    }

    /**
     * Save a node (vertex).
     * 
     * For updates, keep in mind that the label(s) cannot be changed.
     * 
     * Properties will be created/updated/deleted as necessary.
     * 
     * Expected model: { id: "", properties: {}, labels: [] }
     * 
     * @param {*} node 
     */
    async saveNode(node) {
        console.info("saveNode", node)

        await this.query(async function (g) {
            const existing = await g.V(node.id).next()
            console.log(existing)

            if (existing.value) {
                // If it exists already, only update its properties
                console.info("node exists", existing.value)
                await updateProperties(node.id, g, node.properties)
            } else {
                // Create the new node
                const result = await g.addV(node.labels.join("::"))
                    .property(gremlin.process.t.id, node.id)
                    .next()
                console.log(util.inspect(result))
                await updateProperties(node.id, g, node.properties)
            }
        })

    }

    /**
     * Delete a node and its related edges.
     * 
     * @param {*} id 
     */
    async deleteNode(id) {
        console.info("deleteNode", id)

        await this.query(async function (g) {
            await g.V(id).inE().drop().next()
            await g.V(id).outE().drop().next()
            await g.V(id).drop().next()
        })
    }

    /**
     * Save an edge (a relationship between two nodes).
     * 
     * Updates only changed properties, the label and to-from can't be changed.
     * 
     * @param {*} edge 
     */
    async saveEdge(edge) {
        console.info("saveEdge", edge)

        await this.query(async function (g) {

            const existing = await g.E(edge.id).next()
            console.log(existing)

            if (existing.value) {
                // If it exists already, only update its properties
                console.info("Edge exists", existing)
                await updateProperties(edge.id, g, edge.properties, false)
            } else {
                // Create the new edge
                const result = await g.V(edge.to)
                    .as("a")
                    .V(edge.from)
                    .addE(edge.label)
                    .property(gremlin.process.t.id, edge.id)
                    .from_("a")
                    .next()

                console.log(util.inspect(result))

                await updateProperties(edge.id, g, edge.properties, false)
            }

        })
    }

    /**
     * Delete a node and its related edges.
     * 
     * @param {*} id 
     */
    async deleteEdge(id) {
        console.info("deleteEdge", id)

        await this.query(async function (g) {
            await g.E(id).drop().next()
        })
    }

    /**
     * Perform a search that returns nodes and edges.
     * 
     * Sending an empty options object returns all nodes and edges.
     * 
     * Sending `options.focus` will return one node and all of its direct relationships.
     * 
     * (This is a catch-all function for anything that returns the graph or a sub-graph, 
     * it might be better to separate this out into multiple functions)
     * 
     * 
     * @param {*} options 
     * ```json
     * {
     *     focus: {
     *         label: "",
     *         key: "",
     *         value: "", 
     *     }
     * }
     * ```
     * 
     * 
     * @returns {*}
     * ```json
     * { 
     *     nodes: [
     *         { id: "", properties: {}, labels: []}
     *     ], 
     *     edges: [
     *         { id: "", label: "", to: "", from: "", properties: {} }
     *     ]
     * }
     * ```
     * 
     */
    async search(options) {

        // TODO: Create some intuitive options
        //      - Node "A" and its direct edges, plus their edges in common with "A"
        //      - All nodes with label "Person"
        //      - Depth setting to iterate down edges
        //      - A-B-C relationships. People who like movies made by Disney.

        console.info("search", options)

        return await this.query(async function (g) {

            let rawNodes
            if (options.focus) {
                console.info("options.focus", options.focus)
                rawNodes = await g.V()
                    .has(options.focus.label, options.focus.key, options.focus.value)
                    .bothE().bothV().dedup()
                    .valueMap(true).toList()
            } else {
                // Get everything
                rawNodes = await g.V().valueMap(true).toList()
            }
            console.info("rawNodes", rawNodes)

            const rawEdges = await g.E().elementMap().toList()
            console.info("rawEdges", rawEdges)

            const nodes = []
            const edges = []
            for (const n of rawNodes) {
                const node = {
                    id: "",
                    labels: [],
                    properties: {},
                }
                node.id = n.id
                node.labels = n.label
                if (!Array.isArray(node.labels)) {
                    node.labels = [node.labels]
                }
                node.properties = {}
                for (const p in n) {
                    if (p !== "id" && p !== "label") {
                        const val = n[p]
                        if (Array.isArray(val)) {
                            if (val.length == 1) {
                                node.properties[p] = val[0]
                            } else {
                                node.properties[p] = val
                            }
                        } else {
                            node.properties[p] = val
                        }
                    }
                }
                nodes.push(node)
            }
            for (const e of rawEdges) {
                const edge = {
                    id: "",
                    label: "",
                    from: "",
                    to: "",
                    properties: {},
                }
                for (const key in e) {
                    switch (key) {
                        case "id":
                            edge.id = e[key]
                            break
                        case "label":
                            edge.label = e[key]
                            break
                        case "IN":
                            edge.from = e[key].id
                            break
                        case "OUT":
                            edge.to = e[key].id
                            break
                        default:
                            // Everything else is part of properties
                            edge.properties[key] = e[key]
                            break
                    }
                }
                if (nodeExists(nodes, edge.from) && nodeExists(nodes, edge.to)) {
                    edges.push(edge)
                }
            }
            return {
                nodes,
                edges,
            }

        })
    }
}

/**
 * Update the properties of an existing node or edge.
 * 
 * Cardinality is always single for node properties.
 * 
 * @param {*} id 
 */
async function updateProperties(id, g, props, isNode = true) {

    const gve = isNode ? g.V : g.E

    // Compare existing props and delete any that are missing
    const existingProps = await gve.call(g, id).valueMap().toList()
    console.info("existingProps", existingProps)
    for (const ep in existingProps[0]) {
        if (!(ep in props)) {
            console.log("Removing prop", ep)
            const r = await gve.call(g, id).properties(ep).drop().next()
            console.info("Prop drop result", r)
        }
    }

    // We're doing these one at a time to keep things simple.
    // It might be possible to do this in a single traversal but I'm 
    // not sure how to do that or if it would be worth it.
    for (const prop in props) {
        console.log(`Saving prop ${prop}`)
        let r
        if (isNode) {
            r = await gve.call(g, id)
                .property(gremlin.process.cardinality.single, prop, props[prop])
                .next()
        } else {
            r = await gve.call(g, id)
                .property(prop, props[prop])
                .next()
        }
        console.info("Prop save result", r)
    }

}

/**
 * Check to see if the node exists within the array.
 * 
 * @param {*} nodes 
 * @param {*} id 
 * @returns boolean
 */
function nodeExists(nodes, id) {
    for (const node of nodes) {
        if (node.id === id) {
            return true
        }
    }
    console.log(`Node with id ${id} does not exist in search results`)
    return false
}

/**
 * Sigv4 
 * 
 * @param {String} host Database hostname (Neptune cluster Writer endpoint)
 * @param {number} port Database port, typically 8182
 * @param {*} credentials Optional { accessKey, secretKey, sessionToken, region }
 * @param {*} canonicalUri e.g. "/gremlin"
 * @returns {Host, Authorization, X-Amz-Security-Token, X-Amz-Date}
 */
function getHeaders(host, port, credentials, canonicalUri) {

    if (!host || !port) {
        throw new Error("Host and port are required")
    }

    const accessKeyId = credentials.accessKey || credentials.accessKeyId
        || process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = credentials.secretKey || credentials.secretAccessKey
        || process.env.AWS_SECRET_ACCESS_KEY
    const sessionToken = credentials.sessionToken || process.env.AWS_SESSION_TOKEN
    const region = credentials.region || process.env.AWS_DEFAULT_REGION

    if (!accessKeyId || !secretAccessKey) {
        throw new Error("Access key and secret key are required")
    }

    const signOptions = {
        host: `${host}:${port}`,
        region,
        path: canonicalUri,
        service: "neptune-db",
    }

    return aws4.sign(signOptions, { accessKeyId, secretAccessKey, sessionToken }).headers
}

module.exports = { Connection, updateProperties, getHeaders }