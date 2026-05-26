---
title: Jenkins Pipelines
module: cicd
duration_min: 25
difficulty: intermediate
tags: [cicd, jenkins, pipeline, jenkinsfile, declarative, groovy, credentials]
exercises: 4
---

## Overview
Jenkins is the most widely deployed open-source CI/CD server. It powers pipelines via `Jenkinsfile` — a Groovy-based DSL checked into your repo. The declarative pipeline syntax (introduced in Jenkins 2.x) is the modern standard: structured, readable, and portable. Understanding Jenkinsfiles, agents, credentials, and shared libraries is enough for most enterprise environments.

## Concepts

### Declarative Pipeline Structure
```groovy
// Jenkinsfile
pipeline {
    agent any   // run on any available agent

    environment {
        APP_NAME = 'myapp'
        ECR_REPO = '123456789.dkr.ecr.us-east-1.amazonaws.com/myapp'
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '20'))
        disableConcurrentBuilds()
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Test') {
            steps {
                sh 'pip install -r requirements.txt'
                sh 'pytest --tb=short --junitxml=test-results.xml'
            }
            post {
                always {
                    junit 'test-results.xml'
                }
            }
        }

        stage('Build') {
            steps {
                sh 'docker build -t ${APP_NAME}:${BUILD_NUMBER} .'
            }
        }

        stage('Deploy') {
            when {
                branch 'main'
            }
            steps {
                sh './deploy.sh ${BUILD_NUMBER}'
            }
        }
    }

    post {
        success {
            echo 'Pipeline succeeded'
        }
        failure {
            mail to: 'team@example.com',
                 subject: "Build ${BUILD_NUMBER} failed",
                 body: "Check ${BUILD_URL}"
        }
        always {
            cleanWs()   // clean workspace after every run
        }
    }
}
```

### Agents
```groovy
// Any available agent
agent any

// No default agent — each stage declares its own
agent none

// Specific label (run on agents tagged 'docker')
agent { label 'docker' }

// Docker agent (runs the stage inside a container)
agent {
    docker {
        image 'python:3.12-slim'
        args '-v /var/run/docker.sock:/var/run/docker.sock'
    }
}

// Kubernetes pod template
agent {
    kubernetes {
        yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: python
      image: python:3.12-slim
      command: [cat]
      tty: true
'''
    }
}
```

### Credentials
```groovy
// Bind credentials to environment variables
withCredentials([
    usernamePassword(
        credentialsId: 'aws-ecr-creds',
        usernameVariable: 'AWS_ACCESS_KEY_ID',
        passwordVariable: 'AWS_SECRET_ACCESS_KEY'
    )
]) {
    sh 'aws ecr get-login-password | docker login ...'
}

// SSH key
withCredentials([sshUserPrivateKey(
    credentialsId: 'deploy-key',
    keyFileVariable: 'SSH_KEY'
)]) {
    sh 'ssh -i $SSH_KEY user@server ./deploy.sh'
}

// Secret text (e.g. API token)
withCredentials([string(credentialsId: 'slack-token', variable: 'SLACK_TOKEN')]) {
    sh 'curl -H "Authorization: Bearer $SLACK_TOKEN" ...'
}
```

Credentials are stored in **Manage Jenkins → Credentials**, never in the Jenkinsfile.

### Parallel Stages
```groovy
stage('Test and Lint') {
    parallel {
        stage('Unit Tests') {
            steps {
                sh 'pytest tests/unit'
            }
        }
        stage('Integration Tests') {
            steps {
                sh 'pytest tests/integration'
            }
        }
        stage('Lint') {
            steps {
                sh 'ruff check . && mypy src/'
            }
        }
    }
}
```

### Conditional Execution
```groovy
stage('Deploy to Prod') {
    when {
        allOf {
            branch 'main'
            not { changeRequest() }    // not a PR
        }
    }
    steps {
        input message: 'Deploy to production?', ok: 'Deploy'
        sh './deploy-prod.sh'
    }
}
```

`input` pauses the pipeline for manual approval — the build waits until someone clicks "Deploy" or "Abort" in the UI.

### Shared Libraries
Shared libraries let you extract common logic into a reusable Groovy library stored in a separate repo.

```groovy
// In your Jenkinsfile:
@Library('my-shared-lib@main') _   // load the library

pipeline {
    agent any
    stages {
        stage('Build') {
            steps {
                // call a function from the shared library
                buildAndPushDocker(image: 'myapp', tag: env.BUILD_NUMBER)
            }
        }
    }
}
```

```groovy
// vars/buildAndPushDocker.groovy (in the shared library repo):
def call(Map args) {
    sh "docker build -t ${args.image}:${args.tag} ."
    sh "docker push ${args.image}:${args.tag}"
}
```

### Multibranch Pipeline
A Multibranch Pipeline job scans a repo and creates a pipeline for each branch automatically. Push to a new branch → Jenkins creates a new job for it. Delete the branch → Jenkins deletes the job.

Configure in the UI: **New Item → Multibranch Pipeline**, point it at your repo. Jenkins uses the `Jenkinsfile` in each branch.

### Environment Variables
```groovy
// Built-in Jenkins variables
env.BUILD_NUMBER       // "42"
env.BUILD_URL          // full URL to this build
env.JOB_NAME           // "myapp/main"
env.GIT_COMMIT         // git SHA
env.GIT_BRANCH         // "origin/main"
env.WORKSPACE          // path to the build workspace
```

## Examples

### Docker Build + ECR Push
```groovy
pipeline {
    agent any

    environment {
        AWS_REGION    = 'us-east-1'
        ECR_REGISTRY  = '123456789.dkr.ecr.us-east-1.amazonaws.com'
        IMAGE_NAME    = 'myapp'
        IMAGE_TAG     = "${BUILD_NUMBER}-${GIT_COMMIT[0..7]}"
    }

    stages {
        stage('Build & Test') {
            agent {
                docker { image 'python:3.12-slim' }
            }
            steps {
                sh 'pip install -r requirements.txt'
                sh 'pytest --tb=short'
            }
        }

        stage('Docker Build') {
            steps {
                sh "docker build -t ${IMAGE_NAME}:${IMAGE_TAG} ."
            }
        }

        stage('Push to ECR') {
            when { branch 'main' }
            steps {
                withCredentials([[
                    $class: 'AmazonWebServicesCredentialsBinding',
                    credentialsId: 'aws-credentials'
                ]]) {
                    sh """
                        aws ecr get-login-password --region ${AWS_REGION} \
                          | docker login --username AWS --password-stdin ${ECR_REGISTRY}
                        docker tag ${IMAGE_NAME}:${IMAGE_TAG} ${ECR_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}
                        docker push ${ECR_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}
                    """
                }
            }
        }
    }
}
```

## Exercises

1. Write a declarative Jenkinsfile that: checks out code, runs `pytest` in a `python:3.12-slim` Docker agent, publishes JUnit results, and sends a failure email in the `post` block.
2. Add parallel stages to run unit tests and linting simultaneously. Verify both run in parallel by checking the Blue Ocean UI timeline.
3. Configure a `Deploy to Prod` stage that only runs on the `main` branch and requires a manual `input` approval. Use `withCredentials` to inject a deploy SSH key.
4. Create a shared library function `notifySlack(message)` that POSTs to a Slack webhook. Call it from `post { failure { ... } }` in a Jenkinsfile.
