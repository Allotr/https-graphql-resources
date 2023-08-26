#!/bin/bash
rm -rf ./template
faas-cli template pull https://github.com/rafaelpernil2/openfaas-template-node-typescript-uwebsockets
faas-cli deploy -f ./https-graphql-resources.yml
