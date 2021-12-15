aws --profile dcx-west lambda \
    invoke --function-name neptune-gremlin-test-neptunegremlintest74A06448-JmcPNdiBghxn \
    /tmp/lambda-graph-test.txt && cat /tmp/lambda-graph-test.txt