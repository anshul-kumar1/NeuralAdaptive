# Context
Our application currently uses WebGazer for webcam-based eye tracking. Like all 2D pupil-tracking regression systems, its accuracy degrades sharply when the user moves their head out of the original calibrated position—either by turning their head (Yaw/Pitch/Roll) or changing their posture/distance from the screen (Z-axis). WebGazer already runs MediaPipe FaceMesh under the hood to locate the eyes. We want to extract full 3D head pose and posture metrics from this existing FaceMesh data to actively compensate for head movement and stabilize the final gaze coordinates.

# Objective
Please generate a full Technical Design Document (TDD) that details how to create a Head Pose and Posture tracking layer that works in conjunction with our existing 2D eye tracking. Determine the mathematical architecture needed to correct the X/Y gaze coordinates dynamically as the user's head moves or they lean back/forward.

# Features to Design

### Feature 1: Posture & Z-Axis Distance Sizing
When a user leans in or out, the eye crops scale differently, breaking the 2D mapping calibration. We must scale the regression back to baseline.
*   **Requirements:**
    *   Extract the Inter-Pupillary Distance (IPD in pixels) or the overall face bounding box from the MediaPipe landmarks.
    *   Establish and store a "Baseline IPD" during the initial calibration phase.
    *   Continuously calculate the ratio of the current IPD to the baseline IPD.
    *   Implement an algorithm that scales the raw WebGazer (X, Y) output towards or away from the center of the screen based on depth changes (dynamic Z-scaling).

### Feature 2: 6-DoF Head Pose Estimation (Nose/Face tracking)
If a user keeps their eyes locked on a paragraph but slightly turns their head left, the camera sees the pupils move relative to the face, tricking the system into thinking the gaze drifted.
*   **Requirements:**
    *   Extract key FaceMesh landmarks (e.g., nose tip tip, chin, outer eyes, mouth corners).
    *   Calculate the head's Yaw (turning left/right), Pitch (tilting up/down), and Roll.
    *   Since running a full `solvePnP` matrix math might be heavy in JS, propose a lightweight geometric approximation to derive rotation angles from the 2D face mesh.
    *   Create a compensatory offset calculation: map a degree of head Yaw/Pitch to an inverse X/Y pixel offset to counteract false gaze drift.

### Feature 3: Sensor Fusion (Pupil + Head Vectoring)
Instead of treating head pose just as an error corrector, we want to fuse both tracking modalities. A user's face direction acts as a "macro pointer" while their pupils act as a "micro pointer."
*   **Requirements:**
    *   Design a fusion algorithm (e.g., a multi-dimensional Kalman Filter or an adaptive weighted average).
    *   Combine the raw WebGazer pupil point and the Head Pose vector into a single, stabilized `(final_x, final_y)` point.
    *   Implement adaptive weighting: e.g., if the head is turning rapidly, momentarily trust the head vector more; if the head is perfectly still, weigh the pupil data heavier for reading fine text.

### Feature 4: Posture Degradation & Out-of-Bounds Warning System
When the user's posture shifts so radically that mathematical compensation is no longer sufficient, the system needs to recognize the failure state before confusing the user with sporadic UI behavior.
*   **Requirements:**
    *   Define thresholds for maximum allowable head rotation or Z-axis change.
    *   If the user crosses these thresholds, trigger a boolean application state `isTrackerDegraded`.
    *   Provide suggestions on how to visually communicate to the user (non-intrusively) that they should shift back to their original posture or initiate a recalibration logic flow.

# Output Expectations
For your response, please provide:
1.  **System Architecture Pipeline:** How do we hook into WebGazer's internal MediaPipe instance without launching a redundant, CPU-heavy second instance of FaceMesh?
2.  **Mathematics & Code Structures:** Provide pseudo-code or JavaScript snippets specifically for the Distance Sizing ratio math and the lightweight Head Pose (Yaw/Pitch) calculation.
3.  **Sensor Fusion Strategy:** Explain step-by-step how the data from the pupil tracker and the face tracker will be weighted and combined before being dispatched to the frontend DOM.
