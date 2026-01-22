#!/bin/bash
cd /home/kavia/workspace/code-generation/decision-assistant-203666-203675/decision_helper_frontend
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

