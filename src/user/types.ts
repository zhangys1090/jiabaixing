export interface UserProfile {
  userId: string;
  basicInfo: {
    name?: string;
    age?: number;
    gender?: 'male' | 'female' | 'other';
    location?: string;
    language?: string;
  };
  preferences: {
    topics: { [key: string]: number };
    activities: { [key: string]: number };
    communicationStyle: 'formal' | 'casual' | 'friendly' | 'professional';
    responseLength: 'short' | 'medium' | 'long';
    preferredChannels: ('text' | 'voice' | 'video')[];
  };
  behaviorPatterns: {
    dailyRoutine: {
      [time: string]: string[];
    };
    interactionFrequency: number;
    averageSessionDuration: number;
    preferredTimeSlots: string[];
  };
  emotionalProfile: {
    dominantEmotions: { [key: string]: number };
    emotionalTriggers: string[];
    emotionalResponses: { [key: string]: string[] };
  };
  cognitiveProfile: {
    learningStyle: 'visual' | 'auditory' | 'kinesthetic' | 'reading';
    problemSolvingApproach:
      | 'analytical'
      | 'creative'
      | 'practical'
      | 'collaborative';
    informationProcessingSpeed: 'fast' | 'medium' | 'slow';
  };
  contextAwareness: {
    commonScenes: { [key: string]: number };
    devicePreferences: { [key: string]: number };
    environmentalFactors: { [key: string]: number };
  };
  interactionHistory: {
    totalInteractions: number;
    successfulTasks: number;
    failedTasks: number;
    averageSatisfaction: number;
  };
  metadata: {
    lastUpdated: Date;
    profileVersion: number;
    dataSources: string[];
    confidenceScore: number;
  };
}

export interface UserBehavior {
  userId: string;
  timestamp: Date;
  type: 'interaction' | 'task' | 'preference' | 'emotion' | 'context';
  action: string;
  content: string;
  context: {
    scene?: string;
    emotion?: string;
    device?: string;
    location?: string;
    timeOfDay?: string;
  };
  metadata: {
    duration?: number;
    success?: boolean;
    satisfaction?: number;
    relatedEntities?: string[];
  };
}

export interface ProfileUpdateOptions {
  updatePreferences?: boolean;
  updateBehaviorPatterns?: boolean;
  updateEmotionalProfile?: boolean;
  updateCognitiveProfile?: boolean;
  updateContextAwareness?: boolean;
  confidenceThreshold?: number;
}

export interface MemoryDepth {
  userId: string;
  preferenceTrends: {
    topicHistory: Array<{ timestamp: Date; topics: { [key: string]: number } }>;
    activityHistory: Array<{
      timestamp: Date;
      activities: { [key: string]: number };
    }>;
    styleHistory: Array<{ timestamp: Date; style: string }>;
  };
  behaviorTrends: {
    frequencyTrend: Array<{ timestamp: Date; frequency: number }>;
    durationTrend: Array<{ timestamp: Date; duration: number }>;
    timeSlotTrend: Array<{ timestamp: Date; slots: string[] }>;
  };
  emotionalTrends: {
    emotionHistory: Array<{
      timestamp: Date;
      emotions: { [key: string]: number };
    }>;
    triggerFrequency: { [key: string]: number };
    dominantEmotionChanges: Array<{ timestamp: Date; dominantEmotion: string }>;
  };
  metadata: {
    lastUpdated: Date;
    trackingStartDate: Date;
    dataPointsCount: number;
  };
}
