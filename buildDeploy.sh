#!/bin/bash
rm -rf ./template
faas-cli template pull https://github.com/rafaelpernil2/openfaas-template-node-typescript-express
faas-cli up -f ./https-graphql-resources.yml