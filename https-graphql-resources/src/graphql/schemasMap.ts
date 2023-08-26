import 'graphql-import-node';
import * as resourceTypeDefs from "allotr-graphql-schema-types/src/schemas/resource.graphql"
import { DIRECTIVES } from '@graphql-codegen/typescript-mongodb';
import { GraphQLSchema } from "graphql";
import { makeExecutableSchema } from '@graphql-tools/schema'
import { stitchingDirectives } from '@graphql-tools/stitching-directives'
import { mergeResolvers } from "@graphql-tools/merge";
import { ResourceResolvers } from './resolvers/ResourceResolvers';

const { allStitchingDirectivesTypeDefs, stitchingDirectivesValidator } = stitchingDirectives()

const typeDefs = /* GraphQL */ `
  ${allStitchingDirectivesTypeDefs}
  ${DIRECTIVES?.loc?.source?.body}
  ${resourceTypeDefs?.loc?.source?.body}
`
const resolvers = mergeResolvers([ResourceResolvers, {
    Query: {
        // 2. Setup a query that exposes the raw SDL...
        _sdlResource: () => typeDefs,
    },
}]);

const schema: GraphQLSchema = makeExecutableSchema({
    typeDefs,
    resolvers
});

// 3. Include the stitching directives validator...
export default stitchingDirectivesValidator(schema);
